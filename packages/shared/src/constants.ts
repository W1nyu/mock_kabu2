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
const SOCKET_CHANNEL_PREFIXES = ["orderbook:", "trades:", "account:", "news:"] as const;

/** Firehose scope for the news tab: every story, symbol-scoped or market-wide. */
export const NEWS_FEED_SCOPE = "all";

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
  /** 가상 뉴스: news:{symbol} 또는 news:all (전체 피드) */
  news: (scope: string) => redisKey(`news:${scope}`),
} as const;

export const REDIS_CHANNEL_PATTERNS = {
  orderbook: redisKey("orderbook:*"),
  trades: redisKey("trades:*"),
  /** Private account events are authorized by the Socket gateway before a room join. */
  account: redisKey("account:*"),
  news: redisKey("news:*"),
} as const;

/** Converts a namespaced Redis channel to the public Socket room name. */
export function toSocketChannel(redisChannel: string): string | null {
  const prefix = `${REDIS_NAMESPACE}:`;
  if (!redisChannel.startsWith(prefix)) return null;
  const channel = redisChannel.slice(prefix.length);
  return SOCKET_CHANNEL_PREFIXES.some((candidate) => channel.startsWith(candidate)) ? channel : null;
}

/** Redis 캐시 키 */
export const KEYS = {
  /** 최신 호가 스냅샷 JSON — REST 초기 로딩용 */
  orderbookSnapshot: (symbol: string) => redisKey(`snapshot:orderbook:${symbol}`),
  /** 워커가 주기적으로 갱신하는 운영 상태 신호 (짧은 TTL) */
  heartbeat: (worker: string) => redisKey(`heartbeat:${worker}`),
  /** heartbeat와 짝을 이루는 워커 상태 메타데이터 (짧은 TTL) */
  workerHealth: (worker: string) => redisKey(`heartbeat-status:${worker}`),
  /** 단일 writer 워커의 token-guarded Redis leader lease */
  leaderLease: (worker: string) => redisKey(`lease:${worker}`),
} as const;

/** Names used for worker heartbeats and operational health reports. */
export const WORKERS = {
  MATCHING_ENGINE: "matching-engine",
  SETTLEMENT: "settlement",
} as const;

/** 컨슈머 그룹 이름 */
export const CONSUMER_GROUPS = {
  MATCHING: redisKey("matching-engine"),
  SETTLEMENT: redisKey("settlement"),
} as const;

/**
 * Streams are a delivery transport, not the system of record: the order and
 * matching outboxes keep the durable source. Consumers trim only entries that
 * every message in front of the group cursor has ACKed.
 */
export const STREAM_RETENTION = {
  TRIM_INTERVAL_MS: 60_000,
} as const;

/** 시장가 매수 주문의 잔액 홀드 안전 계수 (최근가 * qty * 계수) */
export const MARKET_BUY_HOLD_FACTOR = 1.1;

/**
 * The market-maker keeps roughly this much notional on each side of a book.
 * Shares alone are not comparable between a ₩100 and a ₩100,000 symbol, so
 * bot liquidity derives its per-level quantities from this common budget.
 */
export const LIQUIDITY_TARGET_NOTIONAL_PER_SIDE = 120_000_000;

/**
 * A price-normalised ladder remains bounded even for a future penny-priced
 * listing. The current symbols are all well inside this range.
 */
export const LIQUIDITY_MIN_TOTAL_QTY = 120;
export const LIQUIDITY_MAX_TOTAL_QTY = 2_000_000;

/** Extra inventory covers a live ladder plus its safe cancel/replace overlap. */
export const LIQUIDITY_RESERVE_OVERLAP_MULTIPLIER = 4;

/** Quantity required for one side of a price-normalised reserve ladder. */
export function liquidityTotalQtyForPrice(referencePrice: number): number {
  const price = Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : 1;
  const raw = Math.round(LIQUIDITY_TARGET_NOTIONAL_PER_SIDE / price);
  return Math.min(LIQUIDITY_MAX_TOTAL_QTY, Math.max(LIQUIDITY_MIN_TOTAL_QTY, raw));
}

/**
 * Chart timeframes.
 *
 * Only 1m candles are persisted; everything coarser is aggregated from those
 * on read, so there is one source of truth and nothing to backfill.
 *
 * Buckets are a plain floor of the epoch by `seconds`. That looks like it
 * ignores the trading day, but KST is UTC+9 with no DST, so 09:00 KST is
 * exactly 00:00 UTC — the epoch's own day boundary. A 1d bucket therefore
 * opens at 09:00 KST, and 4h/1h/15m/5m all nest inside it on the same
 * boundaries (09:00, 13:00, 17:00 KST and so on).
 */
export interface CandleIntervalDef {
  id: string;
  label: string;
  seconds: number;
}

export const CANDLE_INTERVALS: readonly CandleIntervalDef[] = [
  { id: "1m", label: "1분", seconds: 60 },
  { id: "5m", label: "5분", seconds: 300 },
  { id: "15m", label: "15분", seconds: 900 },
  { id: "1h", label: "1시간", seconds: 3_600 },
  { id: "4h", label: "4시간", seconds: 14_400 },
  { id: "1d", label: "1일", seconds: 86_400 },
] as const;

/** The interval the settlement consumer actually writes. */
export const BASE_CANDLE_INTERVAL = "1m";
export const DEFAULT_CANDLE_INTERVAL = "1m";
export const DAILY_CANDLE_INTERVAL = "1d";

export function candleIntervalSeconds(id: string): number | null {
  return CANDLE_INTERVALS.find((interval) => interval.id === id)?.seconds ?? null;
}
