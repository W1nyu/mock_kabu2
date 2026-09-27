import { describe, expect, it, vi } from "vitest";
import { FuturesSettlementService } from "../futures-settlement.service";

/** 메모리 위의 계좌·포지션·원장 — Prisma·계좌 락 모양만 흉내 낸다. */
function harness(options: { usdClose?: number | null; withOptions?: boolean; withKcom?: boolean } = {}) {
  const accounts: Record<string, { balance: bigint; holdAmount: bigint }> = {
    long: { balance: 5_000_000n, holdAmount: 0n },
    short: { balance: 400_000n, holdAmount: 0n },
    optBuyer: { balance: 1_000_000n, holdAmount: 0n },
    optWriter: { balance: 100_000n, holdAmount: 0n },
  };
  const positions = new Map<string, { accountId: string; symbol: string; positionSide: string; qty: number; entryValue: bigint; marginHeld: bigint }>([
    // USDF 1,400.0원에 2계약 롱 / 숏
    ["long:USDF:NET", { accountId: "long", symbol: "USDF", positionSide: "NET", qty: 2, entryValue: 28_000n, marginHeld: 1n }],
    ["short:USDF:NET", { accountId: "short", symbol: "USDF", positionSide: "NET", qty: -2, entryValue: 28_000n, marginHeld: 1n }],
  ]);
  if (options.withKcom) {
    // 원자재지수 콜 3번(행사가 100.00pt) — 0.40pt에 2계약 매수 / 쓰기
    positions.set("optBuyer:KCOMC3:NET", { accountId: "optBuyer", symbol: "KCOMC3", positionSide: "NET", qty: 2, entryValue: 80n, marginHeld: 0n });
    positions.set("optWriter:KCOMC3:NET", { accountId: "optWriter", symbol: "KCOMC3", positionSide: "NET", qty: -2, entryValue: 80n, marginHeld: 800_000n });
  }
  if (options.withOptions) {
    // 원/달러 콜 3번(행사가 1,400.0원) — 프리미엄 3.0원에 3계약. 매수자 / 쓰기(봇)
    positions.set("optBuyer:UC3:NET", { accountId: "optBuyer", symbol: "UC3", positionSide: "NET", qty: 3, entryValue: 90n, marginHeld: 0n });
    positions.set("optWriter:UC3:NET", { accountId: "optWriter", symbol: "UC3", positionSide: "NET", qty: -3, entryValue: 90n, marginHeld: 1_260_000n });
    // 원/달러 풋 3번 — 만기에 외가격이라 소멸
    positions.set("optBuyer:UP3:NET", { accountId: "optBuyer", symbol: "UP3", positionSide: "NET", qty: 1, entryValue: 25n, marginHeld: 0n });
    positions.set("optWriter:UP3:NET", { accountId: "optWriter", symbol: "UP3", positionSide: "NET", qty: -1, entryValue: 25n, marginHeld: 420_000n });
  }
  const keyOf = (w: { accountId: string; symbol: string; positionSide: string }) => `${w.accountId}:${w.symbol}:${w.positionSide}`;
  const claims = new Set<string>();
  const debts = new Map<string, bigint>();
  const ledger: { accountId: string; delta: bigint; reason: string }[] = [];
  const settlements = new Map<string, { price: number; positions: number; realizedTotal: bigint }>();
  const outbox: unknown[] = [];
  const realized: { accountId: string; symbol: string; tradeId: string; closedQty: number; realized: bigint }[] = [];
  const marginCalls = [{ id: "c1", resolvedAt: null as Date | null, outcome: null as string | null }];

  const tx = {
    processedEvent: {
      findUnique: async ({ where }: any) => (claims.has(where.eventId) ? { eventId: where.eventId } : null),
      create: async ({ data }: any) => claims.add(data.eventId),
    },
    futuresPosition: {
      findUnique: async ({ where }: any) => positions.get(keyOf(where.accountId_symbol_positionSide)) ?? null,
      update: async ({ where, data }: any) => {
        const k = keyOf(where.accountId_symbol_positionSide);
        positions.set(k, { ...positions.get(k)!, ...data });
      },
    },
    futuresRealized: { create: vi.fn(async ({ data }: any) => void realized.push(data)) },
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
    optionSeries: {
      findMany: async () => [
        ...(options.withOptions ? [{ symbol: "UC3", strike: 14_000 }, { symbol: "UP3", strike: 14_000 }] : []),
        ...(options.withKcom ? [{ symbol: "KCOMC3", strike: 10_000 }] : []),
      ],
    },
    indexEpoch: { findFirst: async () => null },
    marketSymbol: { findMany: async () => [] },
    $queryRaw: async () => [
      ...(options.usdClose === null ? [] : [{ code: "USDKRW", close: options.usdClose ?? 14_100 }]),
      // 원자재 5종 최신 1분봉 종가 — 평균 101.00pt
      ...(options.withKcom
        ? [
            { code: "OIL", close: 10_300 },
            { code: "GAS", close: 9_800 },
            { code: "COPPER", close: 10_100 },
            { code: "GOLD", close: 10_250 },
            { code: "CORN", close: 10_050 },
          ]
        : []),
    ],
  };
  const mutator = {
    withAccountLock: async ([id]: string[], fn: (ctx: any) => Promise<unknown>) =>
      fn({ accounts, tx, updateAccount: async (accountId: string, next: any) => (accounts[accountId] = next) }),
  };
  const redis = { publish: vi.fn(async () => 1) };
  const restrikeStale = vi.fn(async (load: () => Promise<ReadonlyMap<string, number>>) => void (await load()));
  const optionsService = { restrikeStale };
  const service = new FuturesSettlementService(
    prisma as never,
    mutator as never,
    redis as never,
    undefined,
    undefined,
    optionsService as never,
  );
  return { service, restrikeStale, accounts, positions, debts, ledger, settlements, outbox, marginCalls, claims, realized, redis };
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
    h.positions.set("long:USDF:NET", { accountId: "long", symbol: "USDF", positionSide: "NET", qty: 1, entryValue: 14_050n, marginHeld: 1n });
    h.marginCalls.push({ id: "c2", resolvedAt: null, outcome: null });
    const outboxBefore = h.outbox.length;
    await h.service.settle("2026-09-26");
    expect(h.positions.get("long:USDF:NET")!.qty).toBe(1);
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
    expect(h.positions.get("long:USDF:NET")!.qty).toBe(2);
  });

  it("settles options at intrinsic value: buyers get it, writers pay it (debt if short), OTM expires worthless", async () => {
    const h = harness({ withOptions: true });
    const result = await h.service.settle("2026-09-26");

    // 결제가 1,410.0원, 행사가 1,400.0원 콜: 내재가치 100단위 × 1,000원 × 3계약 = 30만 원
    expect(h.accounts.optBuyer.balance).toBe(1_300_000n);
    // 쓰기 봇 잔액 10만 원 → 0원 + 미수금 20만 원
    expect(h.accounts.optWriter.balance).toBe(0n);
    expect(h.debts.get("optWriter")).toBe(200_000n);
    expect(h.ledger.filter((l) => l.reason === "OPTION_EXPIRY").map((l) => [l.accountId, l.delta])).toEqual([
      ["optBuyer", 300_000n],
      ["optWriter", -100_000n],
    ]);
    // 모든 옵션 포지션이 닫히고 쓰기 증거금이 풀린다.
    expect([...h.positions.values()].every((p) => p.qty === 0 && p.marginHeld === 0n)).toBe(true);
    // 실현손익 = 내재가치 − 프리미엄: 매수 (100 − 30) × 3 × 1,000 = 21만, 쓰기 −21만. 풋은 ±2.5만.
    expect(result.symbols.find((s) => s.symbol === "UC3")).toMatchObject({ price: 100, positions: 2, realizedTotal: 0n });
    expect(result.symbols.find((s) => s.symbol === "UP3")).toMatchObject({ price: 0, positions: 2, realizedTotal: 0n });
    expect(h.settlements.get("KC3:2026-09-26")).toMatchObject({ price: 0, positions: 0 });
    // 정산 뒤 다음 거래일 행사가를 다시 깐다.
    expect(h.restrikeStale).toHaveBeenCalled();

    const ledgerBefore = h.ledger.length;
    await h.service.settle("2026-09-26");
    expect(h.ledger.length).toBe(ledgerBefore);
  });

  it("settles KCOM options on the average of the five commodity settlement prices (FX excluded)", async () => {
    const h = harness({ withKcom: true, usdClose: 14_500 });
    const result = await h.service.settle("2026-09-26");

    // KCOM 결제가 101.00pt(원/달러 1,450원은 넣지 않는다), 행사가 100.00pt 콜 내재가치 1.00pt = 100단위
    expect(result.symbols.find((s) => s.symbol === "KCOMC3")).toMatchObject({ price: 100, positions: 2 });
    expect(h.ledger.filter((l) => l.reason === "OPTION_EXPIRY").map((l) => [l.accountId, l.delta])).toEqual([
      ["optBuyer", 200_000n],
      ["optWriter", -100_000n],
    ]);
    expect(h.debts.get("optWriter")).toBe(100_000n);
  });

  it("settles a person's long and short on the same contract separately", async () => {
    const h = harness();
    // 한 계좌가 USDF 롱 2 @ 1,400.0원, 숏 −1 @ 1,420.0원을 같이 들고 있다. 결제가 1,410.0원.
    h.positions.clear();
    h.positions.set("long:USDF:LONG", { accountId: "long", symbol: "USDF", positionSide: "LONG", qty: 2, entryValue: 28_000n, marginHeld: 1n });
    h.positions.set("long:USDF:SHORT", { accountId: "long", symbol: "USDF", positionSide: "SHORT", qty: -1, entryValue: 14_200n, marginHeld: 1n });
    const result = await h.service.settle("2026-09-26");

    expect(h.positions.get("long:USDF:LONG")!.qty).toBe(0);
    expect(h.positions.get("long:USDF:SHORT")!.qty).toBe(0);
    // 롱 +100단위 × 2 × 1,000원 = +200,000, 숏 +100단위 × 1 × 1,000원 = +100,000
    expect(h.realized.map((r) => [r.tradeId, r.closedQty, r.realized])).toEqual([
      ["futures-settle:USDF:2026-09-26:long:LONG", 2, 200_000n],
      ["futures-settle:USDF:2026-09-26:long:SHORT", 1, 100_000n],
    ]);
    expect(h.claims.has("futures-settle:USDF:2026-09-26:long:LONG")).toBe(true);
    expect(h.claims.has("futures-settle:USDF:2026-09-26:long:SHORT")).toBe(true);
    expect(h.accounts.long.balance).toBe(5_300_000n);
    expect(result.symbols.find((s) => s.symbol === "USDF")).toMatchObject({ positions: 2, realizedTotal: 300_000n });
    expect(h.redis.publish).toHaveBeenCalledWith("mock-kabu2:account:long", expect.stringContaining('"positionSide":"SHORT"'));
  });

  it("keeps the old event key for net rows so an already-settled day is not settled again", async () => {
    const h = harness();
    await h.service.settle("2026-09-26");
    expect(h.claims.has("futures-settle:USDF:2026-09-26:long")).toBe(true);
  });
});
