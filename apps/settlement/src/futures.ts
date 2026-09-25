import {
  applyFutureFill,
  applyFuturesCash,
  futurePositionMargin,
  stateAfterTrade,
  type FutureDef,
  type TradeExecutedEvent,
} from "@mock-kabu/shared";

/**
 * 선물 체결 정산. 현물과 달리 체결 대금이 오가지 않는다 — 포지션을 갱신하고, 주문 증거금을 풀고,
 * 포지션 증거금을 다시 잡고, 청산된 부분의 실현손익만 현금(모자라면 미수금)에 반영한다.
 * 호출자가 계좌 락과 트랜잭션을 연다. 멱등성(processed_events)도 호출자가 먼저 확인·기록한다.
 */
export interface FuturesLockContext {
  accounts: Record<string, { balance: bigint; holdAmount: bigint }>;
  updateAccount(accountId: string, next: { balance: bigint; holdAmount: bigint }): Promise<unknown>;
  // Prisma TransactionClient (concurrency TxLike) — 모델 델리게이트는 인덱스 시그니처로 열려 있다.
  tx: { [key: string]: any };
}

interface Leg {
  accountId: string;
  side: "BUY" | "SELL";
  order: { id: string; holdPerUnit: bigint; status: string; qty: number; filledQty: number };
}

export interface FuturesSettlementSummary {
  realizedByAccount: Map<string, bigint>;
}

export async function settleFuturesTrade(
  ctx: FuturesLockContext,
  def: FutureDef,
  event: TradeExecutedEvent,
  buyOrder: Leg["order"],
  sellOrder: Leg["order"],
): Promise<FuturesSettlementSummary> {
  const legs: Leg[] = [
    { accountId: event.buyerAccountId, side: "BUY", order: buyOrder },
    { accountId: event.sellerAccountId, side: "SELL", order: sellOrder },
  ];

  // 계좌별 합산 — 자기 체결이면 한 계좌가 두 다리를 모두 갖는다.
  const release = new Map<string, bigint>();
  const realized = new Map<string, bigint>();

  for (const leg of legs) {
    const where = { accountId_symbol: { accountId: leg.accountId, symbol: event.symbol } };
    const existing = await ctx.tx.futuresPosition.findUnique({ where });
    const before = existing
      ? { qty: existing.qty as number, entryValue: existing.entryValue as bigint }
      : { qty: 0, entryValue: 0n };
    const fill = applyFutureFill(def, before, leg.side, event.price, event.qty);
    const marginHeld = fill.qty === 0 ? 0n : futurePositionMargin(def, fill.entryValue);
    await ctx.tx.futuresPosition.upsert({
      where,
      update: { qty: fill.qty, entryValue: fill.entryValue, marginHeld },
      create: { accountId: leg.accountId, symbol: event.symbol, qty: fill.qty, entryValue: fill.entryValue, marginHeld },
    });
    if (fill.closedQty > 0) {
      // (trade_id, side) unique — 재전달이 두 번 기록하지 못한다.
      await ctx.tx.futuresRealized.create({
        data: {
          accountId: leg.accountId,
          symbol: event.symbol,
          tradeId: event.tradeId,
          side: leg.side,
          closedQty: fill.closedQty,
          price: event.price,
          realized: fill.realized,
        },
      });
    }
    release.set(leg.accountId, (release.get(leg.accountId) ?? 0n) + leg.order.holdPerUnit * BigInt(event.qty));
    realized.set(leg.accountId, (realized.get(leg.accountId) ?? 0n) + fill.realized);
  }

  for (const [accountId, released] of release) {
    const account = ctx.accounts[accountId];
    const holdAmount = account.holdAmount - released;
    const debtRow = await ctx.tx.futuresDebt.findUnique({ where: { accountId } });
    const cash = applyFuturesCash(
      { balance: account.balance, holdAmount, debt: debtRow?.amount ?? 0n },
      realized.get(accountId) ?? 0n,
    );
    await ctx.updateAccount(accountId, { balance: cash.balance, holdAmount });
    if (cash.ledgerDelta !== 0n) {
      await ctx.tx.ledgerEntry.create({
        data: {
          accountId,
          delta: cash.ledgerDelta,
          balanceAfter: cash.balance,
          reason: "FUTURES_PNL",
          refId: event.tradeId,
        },
      });
    }
    if (cash.debt !== (debtRow?.amount ?? 0n)) {
      await ctx.tx.futuresDebt.upsert({
        where: { accountId },
        update: { amount: cash.debt },
        create: { accountId, amount: cash.debt },
      });
    }
  }

  for (const order of [buyOrder, sellOrder]) {
    await ctx.tx.order.update({ where: { id: order.id }, data: stateAfterTrade(order, event.qty) });
  }
  return { realizedByAccount: realized };
}
