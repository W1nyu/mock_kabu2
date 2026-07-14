/** 가입 시 지급되는 가상 현금 보너스 (정수 통화 단위) */
export const SIGNUP_BONUS = 10_000_000;

export interface SymbolDef {
  symbol: string;
  name: string;
  /** 시드/봇 기준가의 시작값 */
  initialPrice: number;
  /** 호가 단위 (봇이 호가를 정렬할 때 사용, API는 강제하지 않음) */
  tickSize: number;
}

/** 가상 종목 5개 */
export const SYMBOLS: SymbolDef[] = [
  { symbol: "MOCK", name: "모의전자", initialPrice: 50_000, tickSize: 50 },
  { symbol: "KABU", name: "카부증권", initialPrice: 120_000, tickSize: 100 },
  { symbol: "TANU", name: "타누키상사", initialPrice: 8_000, tickSize: 10 },
  { symbol: "SAKU", name: "사쿠라중공업", initialPrice: 300_000, tickSize: 500 },
  { symbol: "NEKO", name: "네코물산", initialPrice: 25_000, tickSize: 50 },
];

/** Redis Streams 키 */
export const REDIS_NAMESPACE = "mock-kabu2";

const redisKey = (key: string) => `${REDIS_NAMESPACE}:${key}`;
const PUBLIC_CHANNEL_PREFIXES = ["orderbook:", "trades:", "account:"] as const;

export const STREAMS = {
  /** order-service → matching-engine (주문 접수/취소) */
  ORDERS: redisKey("streams:orders"),
  /** matching-engine → account 정산 컨슈머 (체결/주문 종료) */
  TRADES: redisKey("streams:trades"),
} as const;

/** Redis Pub/Sub 채널 */
export const CHANNELS = {
  /** 심볼별 호가 스냅샷: orderbook:{symbol} */
  orderbook: (symbol: string) => redisKey(`orderbook:${symbol}`),
  /** 심볼별 체결: trades:{symbol} */
  trades: (symbol: string) => redisKey(`trades:${symbol}`),
  /** 계정별 잔액/주문 변경 알림: account:{accountId} */
  account: (accountId: string) => redisKey(`account:${accountId}`),
} as const;

export const REDIS_CHANNEL_PATTERNS = {
  orderbook: redisKey("orderbook:*"),
  trades: redisKey("trades:*"),
} as const;

/** Converts a namespaced Redis channel to the public Socket room name. */
export function toSocketChannel(redisChannel: string): string | null {
  const prefix = `${REDIS_NAMESPACE}:`;
  if (!redisChannel.startsWith(prefix)) return null;
  const channel = redisChannel.slice(prefix.length);
  return PUBLIC_CHANNEL_PREFIXES.some((candidate) => channel.startsWith(candidate)) ? channel : null;
}

/** Redis 캐시 키 */
export const KEYS = {
  /** 최신 호가 스냅샷 JSON — REST 초기 로딩용 */
  orderbookSnapshot: (symbol: string) => redisKey(`snapshot:orderbook:${symbol}`),
} as const;

/** 컨슈머 그룹 이름 */
export const CONSUMER_GROUPS = {
  MATCHING: redisKey("matching-engine"),
  SETTLEMENT: redisKey("settlement"),
} as const;

/** 시장가 매수 주문의 잔액 홀드 안전 계수 (최근가 * qty * 계수) */
export const MARKET_BUY_HOLD_FACTOR = 1.1;

/**
 * The market-maker keeps roughly this much notional on each side of a book.
 * Shares alone are not comparable between a ₩100 and a ₩100,000 symbol, so
 * bot liquidity derives its per-level quantities from this common budget.
 */
export const LIQUIDITY_TARGET_NOTIONAL_PER_SIDE = 48_000_000;

/**
 * A price-normalised ladder remains bounded even for a future penny-priced
 * listing. The current symbols are all well inside this range.
 */
export const LIQUIDITY_MIN_TOTAL_QTY = 120;
export const LIQUIDITY_MAX_TOTAL_QTY = 500_000;

/** Extra inventory covers a live ladder plus its safe cancel/replace overlap. */
export const LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER = 3;

/** Quantity required for one side of a price-normalised reserve ladder. */
export function liquidityTotalQtyForPrice(referencePrice: number): number {
  const price = Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : 1;
  const raw = Math.round(LIQUIDITY_TARGET_NOTIONAL_PER_SIDE / price);
  return Math.min(LIQUIDITY_MAX_TOTAL_QTY, Math.max(LIQUIDITY_MIN_TOTAL_QTY, raw));
}
