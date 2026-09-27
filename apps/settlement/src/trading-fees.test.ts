import { describe, expect, it } from "vitest";
import { futureDef, futureMarginPerContract, optionDef, orderHoldWithFee, tradeNotional, tradingFee, TRADING_FEES_EFFECTIVE_AT as START, type TradeExecutedEvent } from "@mock-kabu/shared";
import { settleTradingFees } from "./trading-fees";
import { settleFuturesTrade, type FuturesLockContext } from "./futures";
import { settleOptionTrade } from "./options";

function context(botIds: string[] = []) {
  const accounts: Record<string, { balance: bigint; holdAmount: bigint }> = {
    A: { balance: 10_000_000n, holdAmount: 0n }, B: { balance: 10_000_000n, holdAmount: 0n },
  };
  const ledger: any[] = [], debts = new Map<string, bigint>(), positions = new Map<string, any>();
  const key = (where: any) =>
    `${where.accountId_symbol_positionSide.accountId}:${where.accountId_symbol_positionSide.symbol}:${where.accountId_symbol_positionSide.positionSide}`;
  const ctx: FuturesLockContext = {
    accounts,
    updateAccount: async (id, next) => { accounts[id] = next; },
    tx: {
      $queryRawUnsafe: async (_sql: string, id: string) => [{ isBot: botIds.includes(id) }],
      ledgerEntry: { create: async ({ data }: any) => ledger.push(data) },
      futuresDebt: {
        findUnique: async ({ where }: any) => ({ amount: debts.get(where.accountId) ?? 0n }),
        upsert: async ({ where, update, create }: any) => {
          const previous = debts.get(where.accountId);
          debts.set(where.accountId, previous == null ? create.amount : typeof update.amount === 'bigint' ? update.amount : previous + update.amount.increment);
        },
      },
      futuresPosition: {
        findUnique: async ({ where }: any) => positions.get(key(where)),
        upsert: async ({ where, update, create }: any) => positions.set(key(where), { ...(positions.get(key(where)) ?? create), ...update }),
      },
      futuresRealized: { create: async () => {} },
      optionSeries: { findUnique: async () => ({ strike: 10_000 }) },
      order: { update: async () => {} },
    },
  };
  return { ctx, accounts, ledger, debts, positions };
}
const event = (overrides: Partial<TradeExecutedEvent> = {}): TradeExecutedEvent => ({
  topic: "trade.executed", eventId: "fee-event", tradeId: "fee-trade", symbol: "KABU", price: 100_000, qty: 10,
  buyOrderId: "buy", sellOrderId: "sell", buyerAccountId: "A", sellerAccountId: "B", takerSide: "BUY", ts: START, ...overrides,
});
const order = (holdPerUnit = 0n, qty = 1) => ({ id: "o", holdPerUnit, qty, filledQty: 0, status: "OPEN" });

describe("trading fees", () => {
  it("starts exactly at 04:20 KST by fill time, not processing time", () => {
    expect(tradingFee(1_000_000n, START - 1)).toBe(0n);
    expect(tradingFee(1_000_000n, START)).toBe(100n);
    expect(tradingFee(1n, START)).toBe(1n);
    expect(tradingFee(0n, START)).toBe(0n);
  });
  it("10x on a million-won margin charges 1,000 won, not 10,000, for each side", async () => {
    const f = context();
    const e = event({ symbol: "KABUF", price: 100_000, qty: 1 });
    f.positions.set("A:KABUF:NET", { qty: 0, entryValue: 0n, marginHeld: 0n, leverage: 10 });
    await settleFuturesTrade(f.ctx, futureDef("KABUF")!, e, order(), order());
    expect(f.positions.get("A:KABUF:NET").marginHeld).toBe(1_000_000n);
    expect(f.accounts.A.balance).toBe(9_999_000n);
    expect(f.accounts.B.balance).toBe(9_999_000n);
    expect(f.ledger.map(r => [r.reason, r.delta])).toEqual([["TRADE_FEE_BUY", -1_000n], ["TRADE_FEE_SELL", -1_000n]]);
    await settleFuturesTrade(f.ctx, futureDef("KABUF")!, { ...e, buyerAccountId: "B", sellerAccountId: "A" }, order(), order());
    expect(f.accounts.A.balance).toBe(9_998_000n);
    expect(f.positions.get("A:KABUF:NET").qty).toBe(0);
  });
  it("uses option premium and exempts the bot writer", async () => {
    const f = context(["B"]), def = optionDef("KCOMC6")!;
    const e = event({ symbol: def.symbol, price: 100, qty: 2 });
    await settleOptionTrade(f.ctx, def, e, order(0n, 2), order(0n, 2));
    const premium = tradeNotional(e.symbol, e.price, e.qty), fee = tradingFee(premium, START);
    expect(f.accounts.A.balance).toBe(10_000_000n - premium - fee);
    expect(f.accounts.B.balance).toBe(10_000_000n + premium);
    expect(f.ledger.filter(r => r.reason.startsWith("TRADE_FEE"))).toHaveLength(1);
  });
  it("both bot sides keep exactly the old cash and debt behavior", async () => {
    const f = context(["A", "B"]);
    for (const accountId of ["A", "B"]) {
      expect(await settleTradingFees(f.ctx, event(), accountId, { balance: 0n, holdAmount: 0n })).toBe(0n);
    }
    expect(f.ledger).toHaveLength(0);
    expect(f.debts.size).toBe(0);
  });
  it("self trades charge both filled sides", async () => {
    const f = context();
    const balance = await settleTradingFees(f.ctx, event({ sellerAccountId: "A" }), "A", { balance: 1_000n, holdAmount: 0n });
    expect(balance).toBe(800n);
    expect(f.ledger.map(r => r.reason)).toEqual(["TRADE_FEE_BUY", "TRADE_FEE_SELL"]);
  });
  it("legacy fully reserved buys keep other reservations and book unpaid fees as debt", async () => {
    const f = context();
    const balance = await settleTradingFees(f.ctx, event(), "A", { balance: 50n, holdAmount: 40n });
    expect(balance).toBe(40n);
    expect(f.debts.get("A")).toBe(90n);
    expect(balance - f.debts.get("A")!).toBe(50n - 100n);
    expect(50n + f.ledger.reduce((sum, row) => sum + row.delta, 0n)).toBe(balance);
    expect(f.ledger.every(r => r.balanceAfter >= 0n)).toBe(true);
  });
  it("delayed pre-cutoff fills are free and produce no fee ledger", async () => {
    const f = context();
    expect(await settleTradingFees(f.ctx, event({ ts: START - 1 }), "A", { balance: 1_000n, holdAmount: 0n })).toBe(1_000n);
    expect(f.ledger).toHaveLength(0);
  });
  it("per-unit reserves cover any partial fills, and zero-margin closes remain available", () => {
    const reserved = orderHoldWithFee(1_005n, "KABU", 1_005, START) * 100n;
    expect(reserved).toBe(100_600n);
    expect(reserved).toBeGreaterThanOrEqual(100_500n + tradingFee(1_005n, START) * 100n);
    expect(orderHoldWithFee(0n, "KABUF", 100_000, START)).toBe(0n);
    const def = futureDef("KABUF")!;
    expect(orderHoldWithFee(futureMarginPerContract(def, 100_000, 10), def.symbol, 100_000, START)).toBe(1_001_000n);
  });
});
