import { expect, it, vi } from "vitest";
import { TRADING_FEES_EFFECTIVE_AT as START, type TradeExecutedEvent } from "@mock-kabu/shared";
import { SettlementWorker } from "./main";

function harness(bots: string[] = []) {
  const accounts: any = { A: { balance: 1_001_000n, holdAmount: 1_000_100n }, B: { balance: 0n, holdAmount: 0n } };
  const holdings: any = { A: { qty: 0, holdQty: 0, costBasis: 0n }, B: { qty: 10, holdQty: 10, costBasis: 900_000n } };
  const orders: any = {
    buy: { id: 'buy', qty: 10, filledQty: 0, status: 'OPEN', holdPerUnit: 100_010n },
    sell: { id: 'sell', qty: 10, filledQty: 0, status: 'OPEN', holdPerUnit: 0n },
  };
  const processed = new Set<string>(), ledger: any[] = [], realized: any[] = [];
  const tx = {
    $queryRawUnsafe: async (_sql: string, id: string) => [{ isBot: bots.includes(id) }],
    processedEvent: {
      findUnique: async ({ where }: any) => processed.has(where.eventId) ? {} : null,
      create: async ({ data }: any) => processed.add(data.eventId),
    },
    order: {
      findUniqueOrThrow: async ({ where }: any) => ({ ...orders[where.id] }),
      update: async ({ where, data }: any) => Object.assign(orders[where.id], data),
    },
    holding: {
      upsert: async ({ where, update }: any) => { const h = holdings[where.accountId_symbol.accountId]; h.qty += update.qty.increment; h.costBasis += update.costBasis.increment; },
      findUniqueOrThrow: async ({ where }: any) => holdings[where.accountId_symbol.accountId],
      update: async ({ where, data }: any) => { const h = holdings[where.accountId_symbol.accountId]; h.qty -= data.qty.decrement; h.holdQty -= data.holdQty.decrement; h.costBasis -= data.costBasis.decrement; },
    },
    ledgerEntry: { create: async ({ data }: any) => ledger.push(data) },
    realizedPnl: { create: async ({ data }: any) => realized.push(data) },
  };
  const mutator = { withAccountLock: async (_ids: string[], fn: any) => {
    const snapshot = structuredClone(accounts), updated = new Set<string>();
    return fn({ tx, accounts: snapshot, updateAccount: async (id: string, next: any) => {
      expect(updated.has(id)).toBe(false); updated.add(id);
      expect(next.balance >= next.holdAmount && next.holdAmount >= 0n).toBe(true);
      accounts[id] = next;
    } });
  } };
  const worker = new SettlementWorker({ $executeRaw: vi.fn() } as never, mutator as never, {} as never, { publish: async () => 1 } as never);
  const fill = (overrides: Partial<TradeExecutedEvent> = {}) => (worker as any).settleTrade({
    topic: 'trade.executed', eventId: 'e1', tradeId: 't1', symbol: 'KABU', price: 100_000, qty: 10,
    buyOrderId: 'buy', sellOrderId: 'sell', buyerAccountId: 'A', sellerAccountId: 'B', takerSide: 'BUY', ts: START, ...overrides,
  });
  return { accounts, orders, ledger, realized, processed, fill };
}

it("spot settlement charges both human sides exactly once on duplicate delivery", async () => {
  const f = harness();
  await f.fill();
  await f.fill();
  expect(f.accounts.A).toEqual({ balance: 900n, holdAmount: 0n });
  expect(f.accounts.B).toEqual({ balance: 999_900n, holdAmount: 0n });
  expect(f.ledger.filter(r => r.reason.startsWith('TRADE_FEE')).map(r => r.delta)).toEqual([-100n, -100n]);
  expect(f.realized).toHaveLength(1);
  for (const [id, initial] of [['A', 1_001_000n], ['B', 0n]] as const) {
    expect(initial + f.ledger.filter(r => r.accountId === id).reduce((sum, r) => sum + r.delta, 0n)).toBe(f.accounts[id].balance);
  }
});

it("bot-to-human spot fills charge only the human on either side", async () => {
  for (const bot of ['A', 'B']) {
    const f = harness([bot]);
    await f.fill();
    expect(f.ledger.filter(r => r.reason.startsWith('TRADE_FEE')).map(r => r.accountId)).toEqual([bot === 'A' ? 'B' : 'A']);
  }
});

it("partial fills charge their actual amount and release only filled reservations", async () => {
  const f = harness();
  await f.fill({ qty: 3 });
  expect(f.accounts.A).toEqual({ balance: 700_970n, holdAmount: 700_070n });
  expect(f.orders.buy).toMatchObject({ status: 'PARTIAL', filledQty: 3 });
  await f.fill({ eventId: 'e2', tradeId: 't2', qty: 7 });
  expect(f.accounts.A).toEqual({ balance: 900n, holdAmount: 0n });
  expect(f.ledger.filter(r => r.reason === 'TRADE_FEE_BUY').map(r => r.delta)).toEqual([-30n, -70n]);
});
