import { describe, expect, it, vi } from "vitest";
import { FuturesSettlementService } from "../futures-settlement.service";

/** 메모리 위의 계좌·포지션·원장 — Prisma·계좌 락 모양만 흉내 낸다. */
function harness(options: { usdClose?: number | null } = {}) {
  const accounts: Record<string, { balance: bigint; holdAmount: bigint }> = {
    long: { balance: 5_000_000n, holdAmount: 0n },
    short: { balance: 400_000n, holdAmount: 0n },
  };
  const positions = new Map<string, { accountId: string; symbol: string; qty: number; entryValue: bigint; marginHeld: bigint }>([
    // USDF 1,400.0원에 2계약 롱 / 숏
    ["long:USDF", { accountId: "long", symbol: "USDF", qty: 2, entryValue: 28_000n, marginHeld: 1n }],
    ["short:USDF", { accountId: "short", symbol: "USDF", qty: -2, entryValue: 28_000n, marginHeld: 1n }],
  ]);
  const claims = new Set<string>();
  const debts = new Map<string, bigint>();
  const ledger: { accountId: string; delta: bigint; reason: string }[] = [];
  const settlements = new Map<string, { price: number; positions: number; realizedTotal: bigint }>();
  const outbox: unknown[] = [];
  const marginCalls = [{ id: "c1", resolvedAt: null as Date | null, outcome: null as string | null }];

  const tx = {
    processedEvent: {
      findUnique: async ({ where }: any) => (claims.has(where.eventId) ? { eventId: where.eventId } : null),
      create: async ({ data }: any) => claims.add(data.eventId),
    },
    futuresPosition: {
      findUnique: async ({ where }: any) =>
        positions.get(`${where.accountId_symbol.accountId}:${where.accountId_symbol.symbol}`) ?? null,
      update: async ({ where, data }: any) => {
        const k = `${where.accountId_symbol.accountId}:${where.accountId_symbol.symbol}`;
        positions.set(k, { ...positions.get(k)!, ...data });
      },
    },
    futuresRealized: { create: vi.fn(async () => undefined) },
    futuresDebt: {
      findUnique: async ({ where }: any) => (debts.has(where.accountId) ? { amount: debts.get(where.accountId)! } : null),
      upsert: async ({ where, update }: any) => debts.set(where.accountId, update.amount),
    },
    ledgerEntry: { create: async ({ data }: any) => ledger.push(data) },
  };
  const prisma = {
    order: { findMany: vi.fn(async () => [{ id: "o1", symbol: "USDF" }]) },
    outbox: { createMany: vi.fn(async ({ data }: any) => outbox.push(...data)) },
    futuresPosition: {
      findMany: async ({ where }: any) =>
        [...positions.values()].filter((p) => p.symbol === where.symbol && p.qty !== 0),
    },
    futuresSettlement: {
      findMany: async ({ where }: any) =>
        [...settlements.entries()].filter(([k]) => k.endsWith(`:${where.tradingDay}`)).map(([k, v]) => ({ symbol: k.split(":")[0], ...v })),
      create: async ({ data }: any) => {
        const k = `${data.symbol}:${data.tradingDay}`;
        if (settlements.has(k)) throw new Error("unique violation");
        settlements.set(k, data);
      },
    },
    futuresMarginCall: {
      updateMany: async ({ data }: any) => {
        for (const call of marginCalls) if (call.resolvedAt == null) Object.assign(call, data);
      },
    },
    indexEpoch: { findFirst: async () => null },
    marketSymbol: { findMany: async () => [] },
    $queryRaw: async () => (options.usdClose === null ? [] : [{ code: "USDKRW", close: options.usdClose ?? 14_100 }]),
  };
  const mutator = {
    withAccountLock: async ([id]: string[], fn: (ctx: any) => Promise<unknown>) =>
      fn({ accounts, tx, updateAccount: async (accountId: string, next: any) => (accounts[accountId] = next) }),
  };
  const redis = { publish: vi.fn(async () => 1) };
  const service = new FuturesSettlementService(prisma as never, mutator as never, redis as never);
  return { service, accounts, positions, debts, ledger, settlements, outbox, marginCalls };
}

describe("futures daily settlement", () => {
  it("closes every position at the underlying's final price, cancels open orders, and records the day", async () => {
    const h = harness();
    const result = await h.service.settle("2026-09-26");

    // 1,400.0 → 1,410.0원: 100단위 × 1,000원 × 2계약 = 20만 원
    expect(h.accounts.long.balance).toBe(5_200_000n);
    expect(h.accounts.short.balance).toBe(200_000n);
    expect([...h.positions.values()].every((p) => p.qty === 0 && p.entryValue === 0n && p.marginHeld === 0n)).toBe(true);
    expect(h.ledger.map((l) => [l.accountId, l.delta, l.reason])).toEqual([
      ["long", 200_000n, "FUTURES_SETTLE"],
      ["short", -200_000n, "FUTURES_SETTLE"],
    ]);
    expect(h.outbox).toHaveLength(1);
    expect(result.symbols.find((s) => s.symbol === "USDF")).toMatchObject({ price: 14_100, positions: 2, realizedTotal: 0n });
    expect(h.settlements.get("USDF:2026-09-26")).toMatchObject({ price: 14_100, positions: 2 });
    expect(h.marginCalls[0].outcome).toBe("SETTLED");
  });

  it("is idempotent — running the same day again changes nothing", async () => {
    const h = harness();
    await h.service.settle("2026-09-26");
    const before = JSON.stringify({ a: h.accounts, l: h.ledger.length }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    await h.service.settle("2026-09-26");
    expect(JSON.stringify({ a: h.accounts, l: h.ledger.length }, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toBe(before);
  });

  it("does not close positions opened after the day was already settled (mid-day restart catch-up)", async () => {
    const h = harness();
    await h.service.settle("2026-09-26");
    // 04:20 이후 새로 연 포지션
    h.positions.set("long:USDF", { accountId: "long", symbol: "USDF", qty: 1, entryValue: 14_050n, marginHeld: 1n });
    h.marginCalls.push({ id: "c2", resolvedAt: null, outcome: null });
    const outboxBefore = h.outbox.length;
    await h.service.settle("2026-09-26");
    expect(h.positions.get("long:USDF")!.qty).toBe(1);
    // 낮에 새로 낸 미체결 주문도 취소하지 않는다(재기동마다 모든 선물 주문이 취소되던 문제).
    expect(h.outbox.length).toBe(outboxBefore);
    expect(h.marginCalls[1].resolvedAt).toBeNull();
  });

  it("turns a loss beyond the balance into debt instead of a negative balance", async () => {
    // 1,400.0 → 1,440.0원: 숏 손실 400단위 × 1,000원 × 2 = 80만 원 > 잔액 40만 원
    const h = harness({ usdClose: 14_400 });
    await h.service.settle("2026-09-26");
    expect(h.accounts.short.balance).toBe(0n);
    expect(h.debts.get("short")).toBe(400_000n);
  });

  it("refuses to close positions at a made-up price when the underlying has no stored value", async () => {
    const h = harness({ usdClose: null });
    await expect(h.service.settle("2026-09-26")).rejects.toThrow(/no settlement price for USDF/);
    expect(h.positions.get("long:USDF")!.qty).toBe(2);
  });
});
