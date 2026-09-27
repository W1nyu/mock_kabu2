import {
  applyFutureFill,
  optionPositionMargin,
  stateAfterTrade,
  type OptionDef,
  type TradeExecutedEvent,
} from "@mock-kabu/shared";
import type { FuturesLockContext } from "./futures";
import { settleTradingFees } from "./trading-fees";

interface Leg {
  accountId: string;
  side: "BUY" | "SELL";
  order: { id: string; holdPerUnit: bigint; status: string; qty: number; filledQty: number };
}

/**
 * 옵션 체결 정산(설계 docs/superpowers/specs/2026-09-26-options-design.md §4).
 * 선물과 달리 체결 때 프리미엄(가격 × 수량 × 승수)이 매수자 → 매도자로 바로 오간다.
 * 포지션(선물과 같은 표: entry_value = 프리미엄 원가)과 쓰기 증거금(margin_held)을 다시 잡고,
 * 청산된 부분의 실현손익을 기록한다(현금은 이미 프리미엄으로 오갔으므로 기록만).
 * 호출자가 계좌 락·트랜잭션·멱등 claim을 연다.
 */
export async function settleOptionTrade(
  ctx: FuturesLockContext,
  def: OptionDef,
  event: TradeExecutedEvent,
  buyOrder: Leg["order"],
  sellOrder: Leg["order"],
): Promise<void> {
  const series = (await ctx.tx.optionSeries.findUnique({ where: { symbol: event.symbol } })) as { strike: number } | null;
  if (!series) throw new Error(`no option series for ${event.symbol}`);
  const legs: Leg[] = [
    { accountId: event.buyerAccountId, side: "BUY", order: buyOrder },
    { accountId: event.sellerAccountId, side: "SELL", order: sellOrder },
  ];
  const premium = BigInt(event.price) * BigInt(event.qty) * BigInt(def.unitValue);
  // 계좌별 합산 — 자기 체결이면 한 계좌가 두 다리를 모두 갖는다.
  const cash = new Map<string, { balance: bigint; release: bigint }>();

  for (const leg of legs) {
    const where = { accountId_symbol: { accountId: leg.accountId, symbol: event.symbol } };
    const existing = await ctx.tx.futuresPosition.findUnique({ where });
    const before = existing ? { qty: existing.qty as number, entryValue: existing.entryValue as bigint } : { qty: 0, entryValue: 0n };
    const fill = applyFutureFill(def, before, leg.side, event.price, event.qty);
    const marginHeld = optionPositionMargin(def, fill.qty, series.strike);
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
    const entry = cash.get(leg.accountId) ?? { balance: 0n, release: 0n };
    entry.balance += leg.side === "BUY" ? -premium : premium;
    entry.release += leg.order.holdPerUnit * BigInt(event.qty);
    cash.set(leg.accountId, entry);
  }

  for (const [accountId, delta] of cash) {
    const account = ctx.accounts[accountId];
    const balance = account.balance + delta.balance;
    if (delta.balance !== 0n) {
      await ctx.tx.ledgerEntry.create({
        data: { accountId, delta: delta.balance, balanceAfter: balance, reason: "OPTION_PREMIUM", refId: event.tradeId },
      });
    }
    const holdAmount = account.holdAmount - delta.release;
    const afterFees = await settleTradingFees(ctx, event, accountId, { balance, holdAmount });
    await ctx.updateAccount(accountId, { balance: afterFees, holdAmount });
  }

  for (const order of [buyOrder, sellOrder]) {
    await ctx.tx.order.update({ where: { id: order.id }, data: stateAfterTrade(order, event.qty) });
  }
}
