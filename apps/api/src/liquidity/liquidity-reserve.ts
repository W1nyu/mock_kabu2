import {
  FUTURES,
  LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER,
  LIQUIDITY_RESERVE_START_INDEX,
  OPTION_FAMILIES,
  SYMBOLS,
  liquidityReserveBotNumber,
  liquidityTotalQtyForPrice,
  type SymbolDef,
} from "@mock-kabu/shared";

/**
 * Dedicated accounts are deliberately outside the original bot1..bot10 pool.
 * Generation 2 starts at bot16: the earlier bot11..bot15 trial reserves may
 * already contain unmatched legacy events in an existing local database, and
 * must stay forensic/read-only instead of being silently reused or repaired.
 */
export { LIQUIDITY_RESERVE_START_INDEX };
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

/** 선물 마켓메이커 예약 계정 — 번호는 shared LIQUIDITY_RESERVE_ORDER로 고정(매칭엔진·봇과 같은 표). */
export interface FuturesLiquidityReserve {
  symbol: string;
  email: string;
  nickname: string;
}

/** 선물 예약 계정이 유지할 가용 현금 하한(원) — 양쪽 호가의 계약별 위탁증거금을 충분히 덮는다. */
export const FUTURES_LIQUIDITY_MIN_AVAILABLE_CASH = 500_000_000n;

export function futuresLiquidityReserves(): FuturesLiquidityReserve[] {
  // 옵션 마켓메이커(기초자산별 1계정, 예: OPT_KABU)도 재고 없이 쓰기 증거금용 현금만 필요해 같은 방식으로 채운다.
  return [...FUTURES.map((future) => future.symbol), ...OPTION_FAMILIES.map((family) => family.reserve)].map((name) => {
    const botNumber = reserveBotNumber(name);
    return { symbol: name, email: `bot${botNumber}@bots.local`, nickname: `Liquidity ${name}` };
  });
}

export function liquidityReserves(): LiquidityReserve[] {
  return SYMBOLS.map((symbol) => {
    const botNumber = reserveBotNumber(symbol.symbol);
    return {
      symbol,
      email: `bot${botNumber}@bots.local`,
      nickname: `Liquidity ${symbol.symbol}`,
    };
  });
}

/** 배정표에 없는 종목은 계정을 만들 수 없다 — 새 종목은 LIQUIDITY_RESERVE_ORDER 끝에 먼저 추가할 것. */
function reserveBotNumber(symbol: string): number {
  const number = liquidityReserveBotNumber(symbol);
  if (number == null) throw new Error(`no liquidity reserve slot for ${symbol}; append it to LIQUIDITY_RESERVE_ORDER`);
  return number;
}

/**
 * The internal bootstrap call is intentionally separate from a browser JWT.
 * In local development it shares the API/bots secret, while deployments can
 * set a narrower LIQUIDITY_BOOTSTRAP_TOKEN explicitly.
 */
export function liquidityBootstrapToken(): string {
  return process.env.LIQUIDITY_BOOTSTRAP_TOKEN ?? process.env.JWT_SECRET ?? "mock-kabu2-local-dev-secret";
}
