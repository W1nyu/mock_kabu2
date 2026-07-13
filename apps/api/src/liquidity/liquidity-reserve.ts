import {
  LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER,
  SYMBOLS,
  liquidityTotalQtyForPrice,
  type SymbolDef,
} from "@mock-kabu/shared";

/**
 * Dedicated accounts are deliberately outside the original bot1..bot10 pool.
 * Generation 2 starts at bot16: the earlier bot11..bot15 trial reserves may
 * already contain unmatched legacy events in an existing local database, and
 * must stay forensic/read-only instead of being silently reused or repaired.
 */
export const LIQUIDITY_RESERVE_START_INDEX = 16;
export const LIQUIDITY_BOT_PASSWORD = process.env.LIQUIDITY_BOT_PASSWORD ?? "botpassword";

/** The amount available after reservations, not the account's raw balance. */
export const LIQUIDITY_MIN_AVAILABLE_CASH = 1_000_000_000n;
/** The amount available after open sell orders for the reserve's own symbol. */
export const LIQUIDITY_MIN_AVAILABLE_QTY = 50_000;

/**
 * A reserve needs enough inventory for the live sell wall and a short safe
 * overlap while replacement orders are accepted before old ones retire. The
 * base floor keeps current local symbols comfortably provisioned; the dynamic
 * branch also supports a future ₩100 listing without making its wall thin.
 */
export function liquidityMinimumAvailableQty(lastPrice: number): number {
  return Math.max(
    LIQUIDITY_MIN_AVAILABLE_QTY,
    liquidityTotalQtyForPrice(lastPrice) * LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER,
  );
}

export interface LiquidityReserve {
  symbol: SymbolDef;
  email: string;
  nickname: string;
}

export function liquidityReserves(): LiquidityReserve[] {
  return SYMBOLS.map((symbol, index) => {
    const botNumber = LIQUIDITY_RESERVE_START_INDEX + index;
    return {
      symbol,
      email: `bot${botNumber}@bots.local`,
      nickname: `Liquidity ${symbol.symbol}`,
    };
  });
}

/**
 * The internal bootstrap call is intentionally separate from a browser JWT.
 * In local development it shares the API/bots secret, while deployments can
 * set a narrower LIQUIDITY_BOOTSTRAP_TOKEN explicitly.
 */
export function liquidityBootstrapToken(): string {
  return process.env.LIQUIDITY_BOOTSTRAP_TOKEN ?? process.env.JWT_SECRET ?? "local-dev-secret-change-me";
}
