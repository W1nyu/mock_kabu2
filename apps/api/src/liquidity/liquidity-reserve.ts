import {
  LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER,
  SYMBOLS,
  liquidityTotalQtyForPrice,
  type SymbolDef, FUTURES } from "@mock-kabu/shared";

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

/** 선물 마켓메이커 예약 계정 — 현물 예약 뒤 번호(bot34~)를 이어 쓴다. 매칭엔진의 매핑과 같은 순서. */
export interface FuturesLiquidityReserve {
  symbol: string;
  email: string;
  nickname: string;
}

/** 선물 예약 계정이 유지할 가용 현금 하한(원) — 양쪽 호가의 계약별 위탁증거금을 충분히 덮는다. */
export const FUTURES_LIQUIDITY_MIN_AVAILABLE_CASH = 500_000_000n;

export function futuresLiquidityReserves(): FuturesLiquidityReserve[] {
  return FUTURES.map((future, index) => {
    const botNumber = LIQUIDITY_RESERVE_START_INDEX + SYMBOLS.length + index;
    return { symbol: future.symbol, email: `bot${botNumber}@bots.local`, nickname: `Liquidity ${future.symbol}` };
  });
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
  return process.env.LIQUIDITY_BOOTSTRAP_TOKEN ?? process.env.JWT_SECRET ?? "mock-kabu2-local-dev-secret";
}
