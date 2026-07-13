/**
 * Unsettled-trade recovery is deliberately planned before it is written.
 *
 * `matching.trades` is the durable matching-engine record.  A row missing
 * from `account.processed_events` means the settlement transaction never
 * committed, so this planner reconstructs only the state changes that the
 * normal settlement consumer would have made.  The caller must refuse to
 * apply a plan with any issue.
 */

export interface RecoveryTrade {
  id: string;
  symbol: string;
  price: number;
  qty: number;
  buyOrderId: string;
  sellOrderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  createdAt: Date;
}

export interface RecoveryOrder {
  id: string;
  accountId: string;
  symbol: string;
  side: string;
  qty: number;
  filledQty: number;
  status: string;
  holdPerUnit: bigint;
}

export interface RecoveryAccount {
  id: string;
  balance: bigint;
  holdAmount: bigint;
}

export interface RecoveryHolding {
  accountId: string;
  symbol: string;
  qty: number;
  holdQty: number;
  costBasis: bigint;
}

export interface RecoveryInput {
  /** Only matching trades which have no matching processed event. */
  unsettledTrades: RecoveryTrade[];
  /** All orders. Reservation reconciliation must include unrelated open orders too. */
  orders: RecoveryOrder[];
  /** All accounts whose reservation may be recalculated. */
  accounts: RecoveryAccount[];
  /** Existing holdings for the accounts and symbols covered by orders. */
  holdings: RecoveryHolding[];
  /** Sum of every recorded matching trade (settled or not) by order id. */
  recordedFillQtyByOrder: ReadonlyMap<string, number>;
  /** Sum of matching trades with no processed event by order id. */
  unsettledFillQtyByOrder: ReadonlyMap<string, number>;
  /** Symbols known to market.symbols. */
  knownSymbols: ReadonlySet<string>;
}

export interface RecoveryIssue {
  code:
    | "ACCOUNT_MISSING"
    | "BUY_ORDER_INVALID"
    | "SELL_ORDER_INVALID"
    | "MARKET_SYMBOL_MISSING"
    | "ORDER_OVERFILLED"
    | "ORDER_FILLED_QTY_MISMATCH"
    | "TRADE_INVALID"
    | "INSUFFICIENT_RESERVED_CASH"
    | "INSUFFICIENT_CASH"
    | "INSUFFICIENT_HOLDING"
    | "INSUFFICIENT_RESERVED_HOLDING"
    | "INVALID_POST_STATE";
  message: string;
  tradeId?: string;
  orderId?: string;
  accountId?: string;
}

export interface PlannedLedgerEntry {
  accountId: string;
  delta: bigint;
  balanceAfter: bigint;
  reason: "TRADE_BUY" | "TRADE_SELL";
  refId: string;
}

export interface PlannedAccount extends RecoveryAccount {
  /** The normal account mutator advances version once per settled trade. */
  versionIncrement: number;
}

export interface PlannedHolding extends RecoveryHolding {
  existed: boolean;
}

export interface PlannedOrder {
  id: string;
  filledQty: number;
  status: string;
}

/** A deterministic reservation correction performed before replay. */
export interface ReservationAccountAdjustment {
  accountId: string;
  fromHoldAmount: bigint;
  toHoldAmount: bigint;
}

/** A deterministic reservation correction performed before replay. */
export interface ReservationHoldingAdjustment {
  accountId: string;
  symbol: string;
  fromHoldQty: number;
  toHoldQty: number;
}

export interface AffectedCandleBucket {
  symbol: string;
  /** UTC minute boundary; PostgreSQL timestamps are stored without a zone. */
  bucket: Date;
}

export interface RecoveryPlan {
  issues: RecoveryIssue[];
  /** Reservation changes derived from all orders and matching history. */
  preReplayAccountReservations: ReservationAccountAdjustment[];
  /** Reservation changes derived from all orders and matching history. */
  preReplayHoldingReservations: ReservationHoldingAdjustment[];
  settledTradeIds: string[];
  processedEventIds: string[];
  ledgerEntries: PlannedLedgerEntry[];
  accounts: PlannedAccount[];
  holdings: PlannedHolding[];
  orders: PlannedOrder[];
  affectedCandleBuckets: AffectedCandleBucket[];
}

type SettlementPlan = Omit<
  RecoveryPlan,
  "preReplayAccountReservations" | "preReplayHoldingReservations"
>;

interface HoldingState extends PlannedHolding {}

const ACTIVE_ORDER_STATUSES = new Set(["OPEN", "PARTIAL"]);
const TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "REJECTED"]);

const holdingKey = (accountId: string, symbol: string) => `${accountId}\u0000${symbol}`;

function sameDateMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function sameAccount(a: PlannedAccount, b: PlannedAccount): boolean {
  return a.id === b.id;
}

function cloneAccount(account: PlannedAccount): PlannedAccount {
  return { ...account };
}

function cloneHolding(holding: HoldingState): HoldingState {
  return { ...holding };
}

function addIssue(
  issues: RecoveryIssue[],
  issue: RecoveryIssue,
): void {
  issues.push(issue);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validOrderState(order: RecoveryOrder, recordedQty: number): RecoveryIssue | null {
  if (!Number.isSafeInteger(order.qty) || order.qty <= 0 || !Number.isSafeInteger(order.filledQty) || order.filledQty < 0) {
    return {
      code: "ORDER_FILLED_QTY_MISMATCH",
      orderId: order.id,
      message: `주문 ${order.id}의 수량 상태가 올바르지 않습니다.`,
    };
  }
  if (recordedQty > order.qty) {
    return {
      code: "ORDER_OVERFILLED",
      orderId: order.id,
      message: `주문 ${order.id}의 매칭 체결 합계(${recordedQty})가 주문 수량(${order.qty})을 초과합니다.`,
    };
  }
  if (order.filledQty > recordedQty) {
    return {
      code: "ORDER_FILLED_QTY_MISMATCH",
      orderId: order.id,
      message: `주문 ${order.id}의 DB 체결 수량(${order.filledQty})이 매칭 체결 합계(${recordedQty})보다 큽니다.`,
    };
  }
  if (!ACTIVE_ORDER_STATUSES.has(order.status) && !TERMINAL_ORDER_STATUSES.has(order.status)) {
    return {
      code: "ORDER_FILLED_QTY_MISMATCH",
      orderId: order.id,
      message: `주문 ${order.id}의 상태(${order.status})를 복구 루틴이 해석할 수 없습니다.`,
    };
  }
  if (TERMINAL_ORDER_STATUSES.has(order.status) && order.filledQty !== recordedQty) {
    return {
      code: "ORDER_FILLED_QTY_MISMATCH",
      orderId: order.id,
      message: `종결 주문 ${order.id}의 체결 수량(${order.filledQty})이 매칭 체결 합계(${recordedQty})와 다릅니다. 종결 이벤트를 먼저 점검해야 합니다.`,
    };
  }
  if (order.status === "REJECTED" && recordedQty !== 0) {
    return {
      code: "ORDER_FILLED_QTY_MISMATCH",
      orderId: order.id,
      message: `거절된 주문 ${order.id}에 매칭 체결이 존재합니다.`,
    };
  }
  return null;
}

/**
 * Produces a complete, all-or-nothing recovery plan.  The caller must only
 * execute it when `issues.length === 0`; no best-effort/partial settlement is
 * ever safe because later trades depend on the earlier account state.
 */
function buildSettlementPlan(input: RecoveryInput): SettlementPlan {
  const issues: RecoveryIssue[] = [];
  const ordersById = new Map(input.orders.map((order) => [order.id, order]));
  const accountsById = new Map<string, PlannedAccount>(
    input.accounts.map((account) => [account.id, { ...account, versionIncrement: 0 }]),
  );
  const initialAccounts = new Map(input.accounts.map((account) => [account.id, account]));
  const holdingStates = new Map<string, HoldingState>();
  for (const holding of input.holdings) {
    holdingStates.set(holdingKey(holding.accountId, holding.symbol), { ...holding, existed: true });
  }
  const initialHoldings = new Map(holdingStates);
  const ledgerEntries: PlannedLedgerEntry[] = [];
  const settledTradeIds: string[] = [];
  const bucketByKey = new Map<string, AffectedCandleBucket>();

  // Validate every touched order against the immutable matching history before
  // making any simulated state transition.
  const invalidOrderIds = new Set<string>();
  for (const order of input.orders) {
    const issue = validOrderState(order, input.recordedFillQtyByOrder.get(order.id) ?? 0);
    if (issue) {
      invalidOrderIds.add(order.id);
      addIssue(issues, issue);
    }
  }

  const sortedTrades = [...input.unsettledTrades].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  for (const trade of sortedTrades) {
    const buyOrder = ordersById.get(trade.buyOrderId);
    const sellOrder = ordersById.get(trade.sellOrderId);
    const buyer = accountsById.get(trade.buyerAccountId);
    const seller = accountsById.get(trade.sellerAccountId);
    const beforeIssueCount = issues.length;

    if (!isPositiveInteger(trade.price) || !isPositiveInteger(trade.qty)) {
      addIssue(issues, {
        code: "TRADE_INVALID",
        tradeId: trade.id,
        message: `체결 ${trade.id}의 가격 또는 수량이 올바르지 않습니다.`,
      });
    }
    if (!input.knownSymbols.has(trade.symbol)) {
      addIssue(issues, {
        code: "MARKET_SYMBOL_MISSING",
        tradeId: trade.id,
        message: `체결 ${trade.id}의 종목 ${trade.symbol}이 market.symbols에 없습니다.`,
      });
    }
    if (!buyOrder || invalidOrderIds.has(trade.buyOrderId)) {
      addIssue(issues, {
        code: "BUY_ORDER_INVALID",
        tradeId: trade.id,
        orderId: trade.buyOrderId,
        message: `체결 ${trade.id}의 매수 주문을 안전하게 검증할 수 없습니다.`,
      });
    } else if (
      buyOrder.side !== "BUY" ||
      buyOrder.accountId !== trade.buyerAccountId ||
      buyOrder.symbol !== trade.symbol ||
      buyOrder.holdPerUnit < 0n
    ) {
      addIssue(issues, {
        code: "BUY_ORDER_INVALID",
        tradeId: trade.id,
        orderId: buyOrder.id,
        message: `체결 ${trade.id}와 매수 주문 ${buyOrder.id}의 계정·종목·예약금 정보가 맞지 않습니다.`,
      });
    }
    if (!sellOrder || invalidOrderIds.has(trade.sellOrderId)) {
      addIssue(issues, {
        code: "SELL_ORDER_INVALID",
        tradeId: trade.id,
        orderId: trade.sellOrderId,
        message: `체결 ${trade.id}의 매도 주문을 안전하게 검증할 수 없습니다.`,
      });
    } else if (
      sellOrder.side !== "SELL" ||
      sellOrder.accountId !== trade.sellerAccountId ||
      sellOrder.symbol !== trade.symbol
    ) {
      addIssue(issues, {
        code: "SELL_ORDER_INVALID",
        tradeId: trade.id,
        orderId: sellOrder.id,
        message: `체결 ${trade.id}와 매도 주문 ${sellOrder.id}의 계정·종목 정보가 맞지 않습니다.`,
      });
    }
    if (!buyer) {
      addIssue(issues, {
        code: "ACCOUNT_MISSING",
        tradeId: trade.id,
        accountId: trade.buyerAccountId,
        message: `체결 ${trade.id}의 매수 계정을 찾을 수 없습니다.`,
      });
    }
    if (!seller) {
      addIssue(issues, {
        code: "ACCOUNT_MISSING",
        tradeId: trade.id,
        accountId: trade.sellerAccountId,
        message: `체결 ${trade.id}의 매도 계정을 찾을 수 없습니다.`,
      });
    }
    if (issues.length !== beforeIssueCount || !buyOrder || !sellOrder || !buyer || !seller) continue;

    const cost = BigInt(trade.price) * BigInt(trade.qty);
    const holdConsumed = buyOrder.holdPerUnit * BigInt(trade.qty);
    const buyerAfter = cloneAccount(buyer);
    const sellerAfter = sameAccount(buyer, seller) ? buyerAfter : cloneAccount(seller);

    // The settlement consumer batches account deltas, so a self-trade keeps
    // cash flat but still consumes the BUY order's cash reservation.
    buyerAfter.balance -= cost;
    buyerAfter.holdAmount -= holdConsumed;
    sellerAfter.balance += cost;

    for (const account of sameAccount(buyerAfter, sellerAfter) ? [buyerAfter] : [buyerAfter, sellerAfter]) {
      if (account.holdAmount < 0n) {
        addIssue(issues, {
          code: "INSUFFICIENT_RESERVED_CASH",
          tradeId: trade.id,
          accountId: account.id,
          message: `체결 ${trade.id} 처리에 필요한 매수 예약금이 계정 ${account.id}에 남아 있지 않습니다.`,
        });
      }
      if (account.balance < 0n) {
        addIssue(issues, {
          code: "INSUFFICIENT_CASH",
          tradeId: trade.id,
          accountId: account.id,
          message: `체결 ${trade.id} 처리 후 계정 ${account.id}의 예수금이 음수가 됩니다.`,
        });
      }
      if (account.holdAmount > account.balance) {
        addIssue(issues, {
          code: "INVALID_POST_STATE",
          tradeId: trade.id,
          accountId: account.id,
          message: `체결 ${trade.id} 처리 후 계정 ${account.id}의 예약금이 예수금을 초과합니다.`,
        });
      }
    }

    const buyerHoldingKey = holdingKey(trade.buyerAccountId, trade.symbol);
    const sellerHoldingKey = holdingKey(trade.sellerAccountId, trade.symbol);
    const existingBuyerHolding = holdingStates.get(buyerHoldingKey);
    const existingSellerHolding = holdingStates.get(sellerHoldingKey);
    const buyerHoldingAfter: HoldingState = existingBuyerHolding
      ? cloneHolding(existingBuyerHolding)
      : {
          accountId: trade.buyerAccountId,
          symbol: trade.symbol,
          qty: 0,
          holdQty: 0,
          costBasis: 0n,
          existed: false,
        };
    buyerHoldingAfter.qty += trade.qty;
    buyerHoldingAfter.costBasis += cost;

    // The normal consumer upserts the buyer first and then reads the seller.
    // Keeping that order makes self-trade recovery exactly mirror production.
    const sellerSource = buyerHoldingKey === sellerHoldingKey ? buyerHoldingAfter : existingSellerHolding;
    let sellerHoldingAfter: HoldingState | undefined;
    if (!sellerSource) {
      addIssue(issues, {
        code: "INSUFFICIENT_HOLDING",
        tradeId: trade.id,
        accountId: trade.sellerAccountId,
        message: `체결 ${trade.id}의 매도 계정에 ${trade.symbol} 보유자산이 없습니다.`,
      });
    } else {
      sellerHoldingAfter = cloneHolding(sellerSource);
      if (sellerHoldingAfter.qty < trade.qty) {
        addIssue(issues, {
          code: "INSUFFICIENT_HOLDING",
          tradeId: trade.id,
          accountId: trade.sellerAccountId,
          message: `체결 ${trade.id} 처리에 필요한 ${trade.symbol} 보유 수량이 부족합니다.`,
        });
      }
      if (sellerHoldingAfter.holdQty < trade.qty) {
        addIssue(issues, {
          code: "INSUFFICIENT_RESERVED_HOLDING",
          tradeId: trade.id,
          accountId: trade.sellerAccountId,
          message: `체결 ${trade.id} 처리에 필요한 ${trade.symbol} 매도 예약 수량이 부족합니다.`,
        });
      }
      if (issues.length === beforeIssueCount) {
        const basisReduction =
          sellerHoldingAfter.qty > 0
            ? (sellerHoldingAfter.costBasis * BigInt(trade.qty)) / BigInt(sellerHoldingAfter.qty)
            : 0n;
        sellerHoldingAfter.qty -= trade.qty;
        sellerHoldingAfter.holdQty -= trade.qty;
        sellerHoldingAfter.costBasis -= basisReduction;
        if (
          sellerHoldingAfter.qty < 0 ||
          sellerHoldingAfter.holdQty < 0 ||
          sellerHoldingAfter.holdQty > sellerHoldingAfter.qty ||
          sellerHoldingAfter.costBasis < 0n
        ) {
          addIssue(issues, {
            code: "INVALID_POST_STATE",
            tradeId: trade.id,
            accountId: trade.sellerAccountId,
            message: `체결 ${trade.id} 처리 후 ${trade.symbol} 보유자산 상태가 유효하지 않습니다.`,
          });
        }
      }
    }

    if (issues.length !== beforeIssueCount || !sellerHoldingAfter) continue;

    accountsById.set(buyerAfter.id, buyerAfter);
    buyerAfter.versionIncrement++;
    if (!sameAccount(buyerAfter, sellerAfter)) {
      accountsById.set(sellerAfter.id, sellerAfter);
      sellerAfter.versionIncrement++;
    }
    if (buyerHoldingKey === sellerHoldingKey) {
      holdingStates.set(buyerHoldingKey, sellerHoldingAfter);
    } else {
      holdingStates.set(buyerHoldingKey, buyerHoldingAfter);
      holdingStates.set(sellerHoldingKey, sellerHoldingAfter);
    }

    const buyerBalanceAfterLedger = buyer.balance - cost;
    const sellerBalanceAfterLedger = sameAccount(buyer, seller)
      ? buyerBalanceAfterLedger + cost
      : seller.balance + cost;
    ledgerEntries.push(
      {
        accountId: trade.buyerAccountId,
        delta: -cost,
        balanceAfter: buyerBalanceAfterLedger,
        reason: "TRADE_BUY",
        refId: trade.id,
      },
      {
        accountId: trade.sellerAccountId,
        delta: cost,
        balanceAfter: sellerBalanceAfterLedger,
        reason: "TRADE_SELL",
        refId: trade.id,
      },
    );
    settledTradeIds.push(trade.id);
    const bucket = sameDateMinute(trade.createdAt);
    bucketByKey.set(`${trade.symbol}\u0000${bucket.toISOString()}`, { symbol: trade.symbol, bucket });
  }

  const plannedOrders: PlannedOrder[] = [];
  for (const order of input.orders) {
    if (invalidOrderIds.has(order.id)) continue;
    const recordedQty = input.recordedFillQtyByOrder.get(order.id) ?? 0;
    if (!ACTIVE_ORDER_STATUSES.has(order.status)) continue;
    const status = recordedQty >= order.qty ? "FILLED" : recordedQty > 0 ? "PARTIAL" : "OPEN";
    if (order.filledQty !== recordedQty || order.status !== status) {
      plannedOrders.push({ id: order.id, filledQty: recordedQty, status });
    }
  }

  const accounts = [...accountsById.values()].filter((account) => {
    const initial = initialAccounts.get(account.id);
    return (
      !initial ||
      initial.balance !== account.balance ||
      initial.holdAmount !== account.holdAmount ||
      account.versionIncrement > 0
    );
  });
  const holdings = [...holdingStates.values()].filter((holding) => {
    const initial = initialHoldings.get(holdingKey(holding.accountId, holding.symbol));
    return (
      !initial ||
      initial.qty !== holding.qty ||
      initial.holdQty !== holding.holdQty ||
      initial.costBasis !== holding.costBasis
    );
  });

  return {
    issues,
    settledTradeIds,
    processedEventIds: [...settledTradeIds],
    ledgerEntries,
    accounts,
    holdings,
    orders: plannedOrders,
    affectedCandleBuckets: [...bucketByKey.values()],
  };
}

interface ReservationPrestate {
  issues: RecoveryIssue[];
  accounts: RecoveryAccount[];
  holdings: RecoveryHolding[];
  accountAdjustments: ReservationAccountAdjustment[];
  holdingAdjustments: ReservationHoldingAdjustment[];
  finalHoldAmountByAccount: Map<string, bigint>;
  finalHoldQtyByHolding: Map<string, number>;
}

/**
 * Rebuilds reservations from durable inputs rather than trusting possibly
 * stale `hold_amount` / `hold_qty` values.  The pre-replay target retains
 * every unprocessed fill (even for terminal orders) plus the actual remaining
 * quantity of active orders.  That is the precise state the normal consumer
 * needs in order to replay the missing fills safely.
 */
function buildReservationPrestate(input: RecoveryInput): ReservationPrestate {
  const issues: RecoveryIssue[] = [];
  const accountsById = new Map(input.accounts.map((account) => [account.id, { ...account }]));
  const holdingsByKey = new Map(
    input.holdings.map((holding) => [holdingKey(holding.accountId, holding.symbol), { ...holding }]),
  );
  const preCashByAccount = new Map<string, bigint>();
  const finalCashByAccount = new Map<string, bigint>();
  const preQtyByHolding = new Map<string, number>();
  const finalQtyByHolding = new Map<string, number>();

  const addCash = (map: Map<string, bigint>, accountId: string, amount: bigint) => {
    map.set(accountId, (map.get(accountId) ?? 0n) + amount);
  };
  const addQty = (map: Map<string, number>, key: string, qty: number) => {
    map.set(key, (map.get(key) ?? 0) + qty);
  };

  for (const order of input.orders) {
    const recordedQty = input.recordedFillQtyByOrder.get(order.id) ?? 0;
    const unsettledQty = input.unsettledFillQtyByOrder.get(order.id) ?? 0;
    const orderIssue = validOrderState(order, recordedQty);
    if (orderIssue) addIssue(issues, orderIssue);
    if (!Number.isSafeInteger(unsettledQty) || unsettledQty < 0 || unsettledQty > recordedQty) {
      addIssue(issues, {
        code: "ORDER_FILLED_QTY_MISMATCH",
        orderId: order.id,
        message: `주문 ${order.id}의 미정산 체결 합계가 전체 매칭 이력과 맞지 않습니다.`,
      });
      continue;
    }
    if (!accountsById.has(order.accountId)) {
      addIssue(issues, {
        code: "ACCOUNT_MISSING",
        orderId: order.id,
        accountId: order.accountId,
        message: `주문 ${order.id}의 계정을 찾을 수 없습니다.`,
      });
      continue;
    }
    if (order.side !== "BUY" && order.side !== "SELL") {
      addIssue(issues, {
        code: order.side === "BUY" ? "BUY_ORDER_INVALID" : "SELL_ORDER_INVALID",
        orderId: order.id,
        message: `주문 ${order.id}의 매수·매도 구분이 올바르지 않습니다.`,
      });
      continue;
    }

    const activeRemainder = ACTIVE_ORDER_STATUSES.has(order.status)
      ? Math.max(0, order.qty - recordedQty)
      : 0;
    // Before replay: unsettled fills still need their reservation.  After
    // replay: only real resting quantity should remain reserved.
    const preReplayQty = unsettledQty + activeRemainder;
    if (order.side === "BUY") {
      if (order.holdPerUnit < 0n) {
        addIssue(issues, {
          code: "BUY_ORDER_INVALID",
          orderId: order.id,
          message: `매수 주문 ${order.id}의 단위 예약금이 음수입니다.`,
        });
        continue;
      }
      addCash(preCashByAccount, order.accountId, order.holdPerUnit * BigInt(preReplayQty));
      addCash(finalCashByAccount, order.accountId, order.holdPerUnit * BigInt(activeRemainder));
    } else {
      const key = holdingKey(order.accountId, order.symbol);
      addQty(preQtyByHolding, key, preReplayQty);
      addQty(finalQtyByHolding, key, activeRemainder);
    }
  }

  // Accounts/holdings with no order-derived target must have no reservation.
  for (const accountId of accountsById.keys()) {
    if (!preCashByAccount.has(accountId)) preCashByAccount.set(accountId, 0n);
    if (!finalCashByAccount.has(accountId)) finalCashByAccount.set(accountId, 0n);
  }
  for (const key of holdingsByKey.keys()) {
    if (!preQtyByHolding.has(key)) preQtyByHolding.set(key, 0);
    if (!finalQtyByHolding.has(key)) finalQtyByHolding.set(key, 0);
  }

  const accountAdjustments: ReservationAccountAdjustment[] = [];
  for (const [accountId, target] of preCashByAccount) {
    const account = accountsById.get(accountId);
    if (!account) continue;
    if (target < 0n || target > account.balance) {
      addIssue(issues, {
        code: target > account.balance ? "INSUFFICIENT_CASH" : "INVALID_POST_STATE",
        accountId,
        message: `계정 ${accountId}의 복구 직전 예약금 목표(${target})가 현재 예수금(${account.balance})으로는 성립하지 않습니다.`,
      });
      continue;
    }
    if (account.holdAmount !== target) {
      accountAdjustments.push({ accountId, fromHoldAmount: account.holdAmount, toHoldAmount: target });
      account.holdAmount = target;
    }
  }

  const holdingAdjustments: ReservationHoldingAdjustment[] = [];
  for (const [key, target] of preQtyByHolding) {
    const [accountId, symbol] = key.split("\u0000");
    const holding = holdingsByKey.get(key);
    if (!holding) {
      if (target > 0) {
        addIssue(issues, {
          code: "INSUFFICIENT_HOLDING",
          accountId,
          message: `계정 ${accountId}에 ${symbol} 매도 예약을 뒷받침할 보유자산이 없습니다.`,
        });
      }
      continue;
    }
    if (target < 0 || target > holding.qty) {
      addIssue(issues, {
        code: target > holding.qty ? "INSUFFICIENT_HOLDING" : "INVALID_POST_STATE",
        accountId,
        message: `계정 ${accountId}의 ${symbol} 복구 직전 매도 예약 목표(${target})가 보유 수량(${holding.qty})으로는 성립하지 않습니다.`,
      });
      continue;
    }
    if (holding.holdQty !== target) {
      holdingAdjustments.push({
        accountId,
        symbol,
        fromHoldQty: holding.holdQty,
        toHoldQty: target,
      });
      holding.holdQty = target;
    }
  }

  return {
    issues,
    accounts: [...accountsById.values()],
    holdings: [...holdingsByKey.values()],
    accountAdjustments,
    holdingAdjustments,
    finalHoldAmountByAccount: finalCashByAccount,
    finalHoldQtyByHolding: finalQtyByHolding,
  };
}

/**
 * Builds an all-or-nothing recovery plan.  It first derives pre-replay
 * reservations from the entire order book, then replays every missing trade.
 * Any contradiction leaves the plan unsafe; callers must not perform a
 * partial write.
 */
export function buildRecoveryPlan(input: RecoveryInput): RecoveryPlan {
  const prestate = buildReservationPrestate(input);
  const settlement = buildSettlementPlan({
    ...input,
    accounts: prestate.accounts,
    holdings: prestate.holdings,
  });
  const issues = [...prestate.issues, ...settlement.issues];

  const finalAccountsById = new Map(prestate.accounts.map((account) => [account.id, account]));
  for (const account of settlement.accounts) finalAccountsById.set(account.id, account);
  for (const [accountId, expectedHold] of prestate.finalHoldAmountByAccount) {
    const account = finalAccountsById.get(accountId);
    if (account && account.holdAmount !== expectedHold) {
      addIssue(issues, {
        code: "INVALID_POST_STATE",
        accountId,
        message: `계정 ${accountId}의 체결 복구 후 예약금(${account.holdAmount})이 주문 이력상 목표(${expectedHold})와 다릅니다.`,
      });
    }
  }

  const finalHoldingsByKey = new Map(
    prestate.holdings.map((holding) => [holdingKey(holding.accountId, holding.symbol), holding]),
  );
  for (const holding of settlement.holdings) {
    finalHoldingsByKey.set(holdingKey(holding.accountId, holding.symbol), holding);
  }
  for (const [key, expectedHoldQty] of prestate.finalHoldQtyByHolding) {
    const holding = finalHoldingsByKey.get(key);
    if (holding && holding.holdQty !== expectedHoldQty) {
      const [accountId, symbol] = key.split("\u0000");
      addIssue(issues, {
        code: "INVALID_POST_STATE",
        accountId,
        message: `계정 ${accountId}의 ${symbol} 체결 복구 후 매도 예약(${holding.holdQty})이 주문 이력상 목표(${expectedHoldQty})와 다릅니다.`,
      });
    }
  }

  const dedupedIssues = [
    ...new Map(
      issues.map((issue) => [
        `${issue.code}\u0000${issue.tradeId ?? ""}\u0000${issue.orderId ?? ""}\u0000${issue.accountId ?? ""}\u0000${issue.message}`,
        issue,
      ]),
    ).values(),
  ];

  return {
    ...settlement,
    issues: dedupedIssues,
    preReplayAccountReservations: prestate.accountAdjustments,
    preReplayHoldingReservations: prestate.holdingAdjustments,
  };
}
