import {
  applyFutureFill,
  applyFuturesCash,
  applyHedgeFill,
  futurePositionMargin,
  rowSideOf,
  stateAfterTrade,
  type FutureDef,
  type TradeExecutedEvent,
} from "@mock-kabu/shared";
import { settleTradingFees } from "./trading-fees";

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
  order: { id: string; holdPerUnit: bigint; status: string; qty: number; filledQty: number; positionSide?: string | null };
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
    // 사람 계정의 양방향 주문은 그 방향 행(LONG/SHORT), 봇 주문은 순포지션 행(NET).
    const positionSide = rowSideOf(leg.order.positionSide);
    const where = { accountId_symbol_positionSide: { accountId: leg.accountId, symbol: event.symbol, positionSide } };
    const existing = await ctx.tx.futuresPosition.findUnique({ where });
    const before = existing
      ? { qty: existing.qty as number, entryValue: existing.entryValue as bigint }
      : { qty: 0, entryValue: 0n };
    const fill =
      positionSide === "NET"
        ? { ...applyFutureFill(def, before, leg.side, event.price, event.qty), overflow: 0 }
        : applyHedgeFill(def, before, positionSide, leg.side, event.price, event.qty);
    if (fill.overflow > 0) {
      // 접수 단계(청산 가능 수량 검사)가 막으므로 정상이면 일어나지 않는다. 반대 포지션을 열지 않고 기록만 남긴다.
      console.warn(`[settlement] hedge close overflow ${leg.accountId} ${event.symbol} ${positionSide}: ${fill.overflow} (trade ${event.tradeId})`);
    }
    // 포지션 증거금은 그 계좌·종목의 레버리지로(없으면 거래소 기준). 레버리지는 포지션이 없을 때만 바뀐다.
    const leverage = (existing?.leverage as number | null | undefined) ?? null;
    const marginHeld = fill.qty === 0 ? 0n : futurePositionMargin(def, fill.entryValue, leverage);
    await ctx.tx.futuresPosition.upsert({
      where,
      update: { qty: fill.qty, entryValue: fill.entryValue, marginHeld },
      create: { accountId: leg.accountId, symbol: event.symbol, positionSide, qty: fill.qty, entryValue: fill.entryValue, marginHeld },
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
    const balance = await settleTradingFees(ctx, event, accountId, { balance: cash.balance, holdAmount });
    await ctx.updateAccount(accountId, { balance, holdAmount });
  }

  for (const order of [buyOrder, sellOrder]) {
    await ctx.tx.order.update({ where: { id: order.id }, data: stateAfterTrade(order, event.qty) });
  }
  return { realizedByAccount: realized };
}
