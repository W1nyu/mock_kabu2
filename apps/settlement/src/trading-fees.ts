import { tradeNotional, tradingFee, type TradeExecutedEvent } from "@mock-kabu/shared";
import { isTradingFeeExempt } from "@mock-kabu/db";
import type { FuturesLockContext } from "./futures";

/**
 * Called inside the fill's account lock and processed_events transaction, BEFORE the
 * account's single update (optimistic locks permit one update per account).
 * Ordinary buys reserve the fee. Legacy orders and zero-margin liquidation closes
 * may have no free cash: keep the full fee expense and book the unpaid part as debt,
 * preserving balance >= holdAmount and net equity. No old order is canceled.
 */
export async function settleTradingFees(
  ctx: FuturesLockContext,
  event: TradeExecutedEvent,
  accountId: string,
  cash: { balance: bigint; holdAmount: bigint },
): Promise<bigint> {
  const fee = tradingFee(tradeNotional(event.symbol, event.price, event.qty), event.ts);
  if (fee === 0n) return cash.balance;
  if (await isTradingFeeExempt(ctx.tx as Parameters<typeof isTradingFeeExempt>[0], accountId)) return cash.balance;
  let balance = cash.balance;
  const sides = ([["BUY", event.buyerAccountId], ["SELL", event.sellerAccountId]] as const)
    .filter(([, party]) => party === accountId);
  const shortfall = cash.holdAmount + fee * BigInt(sides.length) - balance;
  if (shortfall > 0n) {
    const unpaid = shortfall;
    balance += unpaid;
    await ctx.tx.futuresDebt.upsert({
      where: { accountId },
      update: { amount: { increment: unpaid } },
      create: { accountId, amount: unpaid },
    });
    await ctx.tx.ledgerEntry.create({ data: {
      accountId, delta: unpaid, balanceAfter: balance,
      reason: "TRADE_FEE_DEBT", refId: event.tradeId, createdAt: new Date(event.ts),
    } });
  }
  for (const [side] of sides) {
    balance -= fee;
    await ctx.tx.ledgerEntry.create({ data: {
      accountId, delta: -fee, balanceAfter: balance,
      reason: `TRADE_FEE_${side}`, refId: event.tradeId, createdAt: new Date(event.ts),
    } });
  }
  return balance;
}
