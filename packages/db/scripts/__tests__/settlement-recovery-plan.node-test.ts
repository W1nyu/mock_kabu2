import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecoveryPlan,
  type RecoveryAccount,
  type RecoveryHolding,
  type RecoveryInput,
  type RecoveryOrder,
  type RecoveryTrade,
} from "../settlement-recovery-plan";

const BUYER = "buyer";
const SELLER = "seller";
const SYMBOL = "KABU";

function order(overrides: Partial<RecoveryOrder> = {}): RecoveryOrder {
  return {
    id: "buy-order",
    accountId: BUYER,
    symbol: SYMBOL,
    side: "BUY",
    qty: 10,
    filledQty: 0,
    status: "OPEN",
    holdPerUnit: 100n,
    ...overrides,
  };
}

function trade(overrides: Partial<RecoveryTrade> = {}): RecoveryTrade {
  return {
    id: "trade-1",
    symbol: SYMBOL,
    price: 90,
    qty: 10,
    buyOrderId: "buy-order",
    sellOrderId: "sell-order",
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    createdAt: new Date("2026-07-12T00:00:00.000Z"),
    ...overrides,
  };
}

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const unsettled = overrides.unsettledTrades ?? [trade()];
  return {
    unsettledTrades: unsettled,
    orders: overrides.orders ?? [order(), order({ id: "sell-order", accountId: SELLER, side: "SELL", holdPerUnit: 0n })],
    accounts: overrides.accounts ?? [
      { id: BUYER, balance: 1_000n, holdAmount: 1_000n },
      { id: SELLER, balance: 100n, holdAmount: 0n },
    ],
    holdings: overrides.holdings ?? [
      { accountId: SELLER, symbol: SYMBOL, qty: 10, holdQty: 10, costBasis: 800n },
    ],
    recordedFillQtyByOrder:
      overrides.recordedFillQtyByOrder ??
      new Map([
        ["buy-order", 10],
        ["sell-order", 10],
      ]),
    unsettledFillQtyByOrder:
      overrides.unsettledFillQtyByOrder ??
      new Map(
        unsettled.flatMap((row) => [
          [row.buyOrderId, row.qty] as const,
          [row.sellOrderId, row.qty] as const,
        ]),
      ),
    knownSymbols: overrides.knownSymbols ?? new Set([SYMBOL]),
  };
}

function account(plan: ReturnType<typeof buildRecoveryPlan>, id: string): RecoveryAccount | undefined {
  return plan.accounts.find((row) => row.id === id);
}

function holding(plan: ReturnType<typeof buildRecoveryPlan>, accountId: string): RecoveryHolding | undefined {
  return plan.holdings.find((row) => row.accountId === accountId && row.symbol === SYMBOL);
}

test("plans a normal trade with ledger, reservation, holding, and order updates", () => {
  const plan = buildRecoveryPlan(input());

  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.settledTradeIds, ["trade-1"]);
  assert.equal(account(plan, BUYER)?.balance, 100n);
  assert.equal(account(plan, BUYER)?.holdAmount, 0n);
  assert.equal(account(plan, SELLER)?.balance, 1_000n);
  assert.deepEqual(holding(plan, BUYER), {
    accountId: BUYER,
    symbol: SYMBOL,
    qty: 10,
    holdQty: 0,
    costBasis: 900n,
    existed: false,
  });
  assert.deepEqual(holding(plan, SELLER), {
    accountId: SELLER,
    symbol: SYMBOL,
    qty: 0,
    holdQty: 0,
    costBasis: 0n,
    existed: true,
  });
  assert.deepEqual(plan.ledgerEntries, [
    { accountId: BUYER, delta: -900n, balanceAfter: 100n, reason: "TRADE_BUY", refId: "trade-1" },
    { accountId: SELLER, delta: 900n, balanceAfter: 1_000n, reason: "TRADE_SELL", refId: "trade-1" },
  ]);
  assert.deepEqual(plan.orders, [
    { id: "buy-order", filledQty: 10, status: "FILLED" },
    { id: "sell-order", filledQty: 10, status: "FILLED" },
  ]);
});

test("mirrors normal settlement semantics for a self trade", () => {
  const self = "self";
  const plan = buildRecoveryPlan(
    input({
      unsettledTrades: [
        trade({ buyerAccountId: self, sellerAccountId: self, buyOrderId: "self-buy", sellOrderId: "self-sell" }),
      ],
      orders: [
        order({ id: "self-buy", accountId: self }),
        order({ id: "self-sell", accountId: self, side: "SELL", holdPerUnit: 0n }),
      ],
      accounts: [{ id: self, balance: 1_000n, holdAmount: 1_000n }],
      holdings: [{ accountId: self, symbol: SYMBOL, qty: 10, holdQty: 10, costBasis: 800n }],
      recordedFillQtyByOrder: new Map([
        ["self-buy", 10],
        ["self-sell", 10],
      ]),
    }),
  );

  assert.deepEqual(plan.issues, []);
  assert.equal(account(plan, self)?.balance, 1_000n);
  assert.equal(account(plan, self)?.holdAmount, 0n);
  // Buyer upsert is intentionally applied before seller cost-basis reduction.
  assert.deepEqual(holding(plan, self), {
    accountId: self,
    symbol: SYMBOL,
    qty: 10,
    holdQty: 0,
    costBasis: 850n,
    existed: true,
  });
  assert.deepEqual(plan.ledgerEntries.map((entry) => entry.balanceAfter), [100n, 1_000n]);
});

test("reconstructs a missing reservation from order and matching history before replay", () => {
  const plan = buildRecoveryPlan(
    input({
      accounts: [
        { id: BUYER, balance: 1_000n, holdAmount: 999n },
        { id: SELLER, balance: 100n, holdAmount: 0n },
      ],
    }),
  );

  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.preReplayAccountReservations, [
    { accountId: BUYER, fromHoldAmount: 999n, toHoldAmount: 1_000n },
  ]);
  assert.equal(plan.settledTradeIds.length, 1);
});

test("blocks the plan when the deterministic reservation target exceeds cash", () => {
  const plan = buildRecoveryPlan(
    input({
      accounts: [
        { id: BUYER, balance: 999n, holdAmount: 0n },
        { id: SELLER, balance: 100n, holdAmount: 0n },
      ],
    }),
  );

  assert.equal(plan.settledTradeIds.length, 0);
  assert.ok(plan.issues.some((issue) => issue.code === "INSUFFICIENT_CASH"));
});

test("blocks terminal orders whose close state disagrees with matching history", () => {
  const plan = buildRecoveryPlan(
    input({
      orders: [
        order({ status: "FILLED", filledQty: 5 }),
        order({ id: "sell-order", accountId: SELLER, side: "SELL", holdPerUnit: 0n }),
      ],
    }),
  );

  assert.equal(plan.settledTradeIds.length, 0);
  assert.ok(plan.issues.some((issue) => issue.code === "ORDER_FILLED_QTY_MISMATCH"));
});

test("an empty candidate set has no side effects and is naturally idempotent", () => {
  const plan = buildRecoveryPlan(
    input({
      unsettledTrades: [],
      orders: [],
      accounts: [],
      holdings: [],
      recordedFillQtyByOrder: new Map(),
      unsettledFillQtyByOrder: new Map(),
    }),
  );

  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.settledTradeIds, []);
  assert.deepEqual(plan.ledgerEntries, []);
  assert.deepEqual(plan.accounts, []);
});
