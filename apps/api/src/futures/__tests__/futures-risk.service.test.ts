import { describe, expect, it, vi } from "vitest";
import { FuturesRiskService } from "../futures-risk.service";

// 한낮(KST 13:00) — 점검 시간이 아니다.
const NOON = Date.parse("2026-09-26T04:00:00Z");
const MIN = 60_000;

/**
 * USDF 1,400.0원 10계약 롱 한 계좌. 명목 1억4천만 원 — 위탁증거금 6,762,000, 1,380.0원에서 유지증거금 4,443,600.
 * Prisma 모양만 흉내 낸 메모리 저장소.
 */
function harness(options: { balance?: bigint; mark?: number } = {}) {
  const state = {
    balance: options.balance ?? 10_000_000n,
    mark: options.mark ?? 14_000,
    positions: [{ accountId: "a", symbol: "USDF", qty: 10, entryValue: 140_000n, marginHeld: 6_762_000n }],
    calls: [] as { id: string; accountId: string; startedAt: Date; deadline: Date; required: bigint; resolvedAt: Date | null; outcome: string | null }[],
    orders: [] as { id: string; accountId: string; symbol: string; side: string; type: string; qty: number; holdPerUnit: bigint; status: string }[],
    liquidations: [] as { orderId: string; accountId: string; reason: string; createdAt: Date; qty: number; side: string }[],
    outbox: [] as { topic: string; payload: any }[],
  };
  let seq = 0;
  const db: any = {
    futuresPosition: { findMany: async () => state.positions.filter((p) => p.qty !== 0) },
    futuresMarginCall: {
      findMany: async () => state.calls.filter((c) => c.resolvedAt == null),
      create: async ({ data }: any) => {
        const row = { id: `call${++seq}`, resolvedAt: null, outcome: null, ...data };
        state.calls.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        for (const c of state.calls) if (c.id === where.id && c.resolvedAt == null) Object.assign(c, data);
      },
    },
    marketSymbol: { findMany: async () => [{ symbol: "USDF", lastPrice: state.mark }] },
    account: { findMany: async () => [{ id: "a", balance: state.balance }] },
    futuresDebt: { findMany: async () => [] },
    futuresLiquidation: {
      findMany: async () => state.liquidations,
      create: async ({ data }: any) => state.liquidations.push({ ...data, createdAt: new Date(NOON) }),
    },
    order: {
      findMany: async ({ where }: any) =>
        state.orders.filter(
          (o) =>
            (!where.accountId || o.accountId === where.accountId) &&
            (where.holdPerUnit == null || o.holdPerUnit === where.holdPerUnit) &&
            where.status.in.includes(o.status),
        ),
      create: async ({ data }: any) => {
        const row = { id: `order${++seq}`, status: "OPEN", ...data };
        state.orders.push(row);
        return row;
      },
    },
    outbox: { create: async ({ data }: any) => state.outbox.push(data) },
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  const redis = { publish: vi.fn(async () => 1) };
  const service = new FuturesRiskService(db as never, redis as never);
  const placed = () => state.outbox.filter((o) => o.topic === "order.placed").map((o) => o.payload);
  return { service, state, redis, placed };
}

describe("futures margin call and forced liquidation", () => {
  it("does nothing while equity covers the maintenance margin", async () => {
    const h = harness();
    await h.service.tick(NOON);
    expect(h.state.calls).toHaveLength(0);
    expect(h.placed()).toHaveLength(0);
  });

  it("opens a 30-minute margin call below maintenance and resolves it once equity reaches the initial margin", async () => {
    // 1,380.0원: 평가손익 −200만, 평가예탁금 400만 < 유지증거금 4,443,600
    const h = harness({ balance: 6_000_000n, mark: 13_800 });
    await h.service.tick(NOON);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0]).toMatchObject({ required: 2_665_400n, resolvedAt: null });
    expect(h.state.calls[0].deadline.getTime()).toBe(NOON + 30 * MIN);
    expect(h.redis.publish).toHaveBeenCalledWith("mock-kabu2:account:a", expect.stringContaining('"status":"OPEN"'));

    // 같은 상황이 이어져도 두 번 열지 않고, 기한 전에는 반대매매하지 않는다.
    await h.service.tick(NOON + 10 * MIN);
    expect(h.state.calls).toHaveLength(1);
    expect(h.placed()).toHaveLength(0);

    // 입금으로 위탁증거금(6,665,400) 수준 회복 → 해소
    h.state.balance = 8_700_000n;
    await h.service.tick(NOON + 20 * MIN);
    expect(h.state.calls[0].outcome).toBe("RESOLVED");
    expect(h.placed()).toHaveLength(0);
  });

  it("stays in the call between maintenance and initial margin — only the initial level resolves it", async () => {
    const h = harness({ balance: 6_000_000n, mark: 13_800 });
    await h.service.tick(NOON);
    h.state.balance = 7_000_000n; // 평가예탁금 500만: 유지증거금은 넘지만 위탁증거금엔 못 미친다
    await h.service.tick(NOON + MIN);
    expect(h.state.calls[0].resolvedAt).toBeNull();
  });

  it("after the deadline sells shortfall/initial of the position at market, without holding margin", async () => {
    const h = harness({ balance: 6_000_000n, mark: 13_800 });
    await h.service.tick(NOON);
    await h.service.tick(NOON + 31 * MIN);
    // 추가증거금 2,665,400 ÷ 위탁증거금 6,665,400 ≈ 0.4 → 10계약 중 4계약(올림)
    expect(h.placed()).toEqual([
      expect.objectContaining({ accountId: "a", symbol: "USDF", side: "SELL", type: "MARKET", qty: 4, price: Math.floor(13_800 / 1.1) }),
    ]);
    expect(h.state.orders[0].holdPerUnit).toBe(0n);
    expect(h.state.liquidations[0]).toMatchObject({ reason: "DEADLINE", qty: 4 });
    expect(h.state.calls[0].outcome).toBe("LIQUIDATED");

    // 반대매매 주문이 아직 살아 있으면 다음 틱이 또 내지 않는다.
    await h.service.tick(NOON + 32 * MIN);
    expect(h.placed()).toHaveLength(1);
    expect(h.state.calls.filter((c) => c.resolvedAt == null)).toHaveLength(0);
  });

  it("cancels the account's own live futures orders before liquidating", async () => {
    const h = harness({ balance: 6_000_000n, mark: 13_800 });
    h.state.orders.push({ id: "mine", accountId: "a", symbol: "USDF", side: "BUY", type: "LIMIT", qty: 3, holdPerUnit: 1n, status: "OPEN" });
    await h.service.tick(NOON);
    await h.service.tick(NOON + 31 * MIN);
    const cancels = h.state.outbox.filter((o) => o.topic === "order.cancel.requested");
    expect(cancels.map((c) => c.payload.orderId)).toEqual(["mine"]);
  });

  it("liquidates the whole position immediately once the loss reaches 90% of its initial margin", async () => {
    // 1,339.1원: 손실 609단위 × 1,000원 × 10 = 6,090,000 ≥ 6,762,000 × 90%
    const h = harness({ balance: 100_000_000n, mark: 13_391 });
    await h.service.tick(NOON);
    expect(h.placed()).toEqual([expect.objectContaining({ side: "SELL", qty: 10 })]);
    expect(h.state.liquidations[0].reason).toBe("EMERGENCY");
    expect(h.state.calls[0]).toMatchObject({ outcome: "EMERGENCY" });
  });

  it("buys back a short position and closes the call when positions are gone", async () => {
    const h = harness({ balance: 6_000_000n, mark: 14_200 });
    h.state.positions[0].qty = -10; // 숏 10계약, 1,420.0원: 평가손익 −200만
    await h.service.tick(NOON);
    await h.service.tick(NOON + 31 * MIN);
    expect(h.placed()[0]).toMatchObject({ side: "BUY", price: Math.ceil(14_200 * 1.1) });

    h.state.orders.forEach((o) => (o.status = "FILLED"));
    h.state.positions[0].qty = 0;
    h.state.calls.push({ id: "old", accountId: "a", startedAt: new Date(NOON), deadline: new Date(NOON), required: 1n, resolvedAt: null, outcome: null });
    await h.service.tick(NOON + 33 * MIN);
    expect(h.state.calls.find((c) => c.id === "old")!.outcome).toBe("RESOLVED");
  });

  it("does not run during the daily maintenance window", async () => {
    const h = harness({ balance: 100_000_000n, mark: 13_391 });
    await h.service.tick(Date.parse("2026-09-25T19:15:00Z")); // 04:15 KST
    expect(h.placed()).toHaveLength(0);
  });
});
