import { futureDef } from "./futures";
import { optionDef } from "./options";

/** 2026-09-28 04:20 KST: charge by execution time, including delayed/replayed fills. */
export const TRADING_FEES_EFFECTIVE_AT = Date.parse("2026-09-27T19:20:00Z");
export const TRADING_FEE_BPS = 1;

/** Spot consideration, futures notional, or option premium, in whole won. */
export function tradeNotional(symbol: string, price: number, qty = 1): bigint {
  const multiplier = futureDef(symbol)?.unitValue ?? optionDef(symbol)?.unitValue ?? 1;
  return BigInt(price) * BigInt(qty) * BigInt(multiplier);
}

/** 0.01% per filled side, rounded UP to a whole won per execution. No leverage applied twice. */
export function tradingFee(notional: bigint, at = Date.now()): bigint {
  if (at < TRADING_FEES_EFFECTIVE_AT || notional <= 0n) return 0n;
  return (notional * BigInt(TRADING_FEE_BPS) + 9_999n) / 10_000n;
}

/** Reserve per unit so any partial-fill split is funded. Zero-margin closes stay possible. */
export function orderHoldWithFee(principal: bigint, symbol: string, price: number, at = Date.now()): bigint {
  return principal > 0n ? principal + tradingFee(tradeNotional(symbol, price), at) : 0n;
}
