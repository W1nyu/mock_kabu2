import { FUTURES, futureDef } from "./futures";

/** 가입 시 지급되는 가상 현금 보너스 (정수 통화 단위) */
export const SIGNUP_BONUS = 10_000_000;
/** 시드가 만드는 관리자 계정의 닉네임. 닉네임은 유일하므로 이 이름이 곧 시스템 계정 식별자다(랭킹 제외). */
export const ADMIN_NICKNAME = "admin";

export interface SymbolDef {
  symbol: string;
  name: string;
  /** 시드/봇 기준가의 시작값 */
  initialPrice: number;
  /** 호가 단위. 지정가 주문은 이 단위의 배수여야 한다(API가 거부) */
  tickSize: number;
  /**
   * 지수용 발행주식수. 상장가 × 발행주식수 = 상장 시가총액이 전 종목 1.2조 원으로 같아,
   * 상장 시점에는 종목마다 지수의 20%를 차지하고 이후에는 가격에 따라 비중이 움직인다.
   */
  listedShares: number;
}

/** 상장 중인 가상 종목 15개 (2026-09-26 MOCK·TANU·PIXL 상장 폐지) */
export const SYMBOLS: SymbolDef[] = [
  { symbol: "KABU", name: "카부증권", initialPrice: 120_000, tickSize: 100, listedShares: 10_000_000 },
  { symbol: "SAKU", name: "사쿠라중공업", initialPrice: 300_000, tickSize: 500, listedShares: 4_000_000 },
  { symbol: "NEKO", name: "네코물산", initialPrice: 25_000, tickSize: 50, listedShares: 48_000_000 },
  // 2026-09-24 추가 상장 — 상장 시가총액은 기존과 같은 1.2조 원
  { symbol: "BORI", name: "보리식품", initialPrice: 4_000, tickSize: 5, listedShares: 300_000_000 },
  { symbol: "BJAY", name: "블루제이항공", initialPrice: 20_000, tickSize: 50, listedShares: 60_000_000 },
  { symbol: "SKYL", name: "스카이링크", initialPrice: 40_000, tickSize: 50, listedShares: 30_000_000 },
  { symbol: "DAON", name: "다온반도체", initialPrice: 400_000, tickSize: 500, listedShares: 3_000_000 },
  // 2026-09-25 추가 상장 — 상장 시가총액 1.2조 원, 처음으로 1원·1,000원 호가 구간
  { symbol: "DDAM", name: "도담건설", initialPrice: 1_500, tickSize: 1, listedShares: 800_000_000 },
  { symbol: "SAEM", name: "샘물바이오", initialPrice: 12_000, tickSize: 10, listedShares: 100_000_000 },
  { symbol: "STEL", name: "스텔라엔터", initialPrice: 30_000, tickSize: 50, listedShares: 40_000_000 },
  { symbol: "SLVR", name: "실버모터스", initialPrice: 80_000, tickSize: 100, listedShares: 15_000_000 },
  { symbol: "NOVA", name: "노바셀배터리", initialPrice: 600_000, tickSize: 1_000, listedShares: 2_000_000 },
  // 2026-09-25 추가 상장 (에너지·유틸리티·부동산)
  { symbol: "NRFD", name: "노스필드정유", initialPrice: 150_000, tickSize: 100, listedShares: 8_000_000 },
  { symbol: "GARM", name: "가람전력", initialPrice: 6_000, tickSize: 10, listedShares: 200_000_000 },
  { symbol: "HAVN", name: "헤이븐리츠", initialPrice: 5_000, tickSize: 10, listedShares: 240_000_000 },
];

/**
 * 상장 폐지된 종목. 거래·뉴스·지수·목록에서 빠지지만, 과거 체결·봉·뉴스·지수 구간과 이름 표시를 위해 정의는 남긴다.
 * 폐지 절차: packages/db/scripts/delist-symbols.ts (미체결 취소, 사용자 보유분 현금 정산, 지수 제외).
 */
export const DELISTED_SYMBOLS: SymbolDef[] = [
  // 2026-09-26 상장 폐지
  { symbol: "MOCK", name: "모의전자", initialPrice: 50_000, tickSize: 50, listedShares: 24_000_000 },
  { symbol: "TANU", name: "타누키상사", initialPrice: 8_000, tickSize: 10, listedShares: 150_000_000 },
  { symbol: "PIXL", name: "픽셀게임즈", initialPrice: 60_000, tickSize: 100, listedShares: 20_000_000 },
];

/** 지수 시작 수준. 첫 구간의 제수는 상장 시가총액 합 ÷ INDEX_BASE_LEVEL이다. */
export const INDEX_BASE_LEVEL = 1000;

/** 시가총액 가중 지수의 한 구간: 이 시각부터 `members`를 같은 `divisor`로 합산한다. */
export interface IndexEpoch {
  startsAt: number;
  divisor: number;
  members: string[];
}

/**
 * 지수 수준 = Σ(가격 × 발행주식수) ÷ 제수. 편입 종목이 바뀌는 시각에는 직전 수준이 그대로
 * 이어지도록 새 제수를 정한다(`continuingDivisor`). 가격이 없는 종목은 호출자가 상장가로 채운다.
 */
export function indexLevel(
  epoch: Pick<IndexEpoch, "divisor" | "members">,
  priceOf: (symbol: string) => number,
  sharesOf: (symbol: string) => number,
): number {
  let cap = 0;
  for (const symbol of epoch.members) cap += priceOf(symbol) * sharesOf(symbol);
  return cap / epoch.divisor;
}

/** 새 편입 구성의 시가총액이 `levelBefore`와 같은 지수 수준이 되게 하는 제수. */
export function continuingDivisor(capAfter: number, levelBefore: number): number {
  return capAfter / levelBefore;
}

/** `ts` 시점에 적용되는 구간(시작 시각 오름차순 목록). */
export function epochAt<T extends Pick<IndexEpoch, "startsAt">>(epochs: readonly T[], ts: number): T | null {
  let found: T | null = null;
  for (const epoch of epochs) {
    if (epoch.startsAt <= ts) found = epoch;
    else break;
  }
  return found;
}

/**
 * 주문 한 건의 상한. DB의 price/qty는 32비트 정수이고 체결 금액은 BigInt로 계산하므로,
 * 여기서 막지 않으면 오버플로가 아니라 "말이 안 되는" 주문(수억 주)이 호가창을 왜곡한다.
 */
export const MAX_ORDER_QTY = 10_000_000;
export const MAX_ORDER_PRICE = 1_000_000_000;

/** 종목의 호가 단위(선물은 정수 가격 단위). 모르는 종목이면 null. */
export function tickSizeOf(symbol: string): number | null {
  return SYMBOLS.find((definition) => definition.symbol === symbol)?.tickSize ?? futureDef(symbol)?.tickUnits ?? null;
}

/** 매칭엔진·주문이 받는 모든 종목(현물 + 선물). 현물 전용 화면·지수는 SYMBOLS를 쓴다. */
export const TRADABLE_SYMBOLS: readonly string[] = [
  ...SYMBOLS.map((definition) => definition.symbol),
  ...FUTURES.map((future) => future.symbol),
];

/** 유동성(마켓메이커) 예약 계정 번호의 시작: bot16 */
export const LIQUIDITY_RESERVE_START_INDEX = 16;
/**
 * 유동성 예약 계정 배정 순서 — 한 번 배정한 번호는 바꾸지 않는다(append-only). 종목 k번째가 bot(16+k).
 * 예전에는 상장 목록 순서로 계산해, 종목을 폐지하면 뒤 종목의 계정이 모두 밀렸다. 폐지 종목의 자리는 비워 둔다.
 */
export const LIQUIDITY_RESERVE_ORDER: readonly string[] = [
  "MOCK", "KABU", "TANU", "SAKU", "NEKO", "BORI", "BJAY", "SKYL", "PIXL", "DAON",
  "DDAM", "SAEM", "STEL", "SLVR", "NOVA", "NRFD", "GARM", "HAVN",
  "KABUF", "USDF", "OILF", "GASF", "CPRF",
  "GOLDF", "CORNF",
];

/** 종목의 유동성 예약 계정 번호(bot N). 배정이 없으면 null. */
export function liquidityReserveBotNumber(symbol: string): number | null {
  const index = LIQUIDITY_RESERVE_ORDER.indexOf(symbol);
  return index < 0 ? null : LIQUIDITY_RESERVE_START_INDEX + index;
}

/** 지정가가 호가 단위 격자 위에 있는지. */
export function isOnTick(price: number, tickSize: number): boolean {
  return Number.isInteger(price) && tickSize > 0 && price % tickSize === 0;
}

/** Redis Streams 키 */
export const REDIS_NAMESPACE = "mock-kabu2";

const redisKey = (key: string) => `${REDIS_NAMESPACE}:${key}`;
const SOCKET_CHANNEL_PREFIXES = ["orderbook:", "trades:", "account:", "news:", "ref:"] as const;

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
  /** 가상 기초자산 최신값: ref:{code} (원/달러·원자재) */
  reference: (code: string) => redisKey(`ref:${code}`),
} as const;

export const REDIS_CHANNEL_PATTERNS = {
  orderbook: redisKey("orderbook:*"),
  trades: redisKey("trades:*"),
  /** Private account events are authorized by the Socket gateway before a room join. */
  account: redisKey("account:*"),
  news: redisKey("news:*"),
  reference: redisKey("ref:*"),
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
  /** 가상 기초자산 최신값 JSON (ReferenceTick) */
  referenceLatest: (code: string) => redisKey(`snapshot:ref:${code}`),
  /** 워커가 주기적으로 갱신하는 운영 상태 신호 (짧은 TTL) */
  heartbeat: (worker: string) => redisKey(`heartbeat:${worker}`),
  /** heartbeat와 짝을 이루는 워커 상태 메타데이터 (짧은 TTL) */
  workerHealth: (worker: string) => redisKey(`heartbeat-status:${worker}`),
  /** 단일 writer 워커의 token-guarded Redis leader lease */
  leaderLease: (worker: string) => redisKey(`lease:${worker}`),
  /** 로그인 시도 카운터 (IP+이메일, 짧은 TTL) */
  loginAttempts: (source: string) => redisKey(`ratelimit:login:${source}`),
  /** 주문 멱등 키 → 주문 ID (24시간 TTL) */
  orderIdempotency: (accountId: string, key: string) => redisKey(`idempotency:order:${accountId}:${key}`),
  /** 주문 취소 요청 표시 — 같은 주문의 취소가 잠깐 사이에 outbox에 여러 번 쌓이지 않게 한다 */
  cancelRequested: (orderId: string) => redisKey(`cancel-requested:${orderId}`),
  /** 운영자가 거는 임시 점검 JSON `{startAt, endAt, message}` — 주문 차단·화면 배너 */
  manualMaintenance: () => redisKey("maintenance:manual"),
  /** 운영자가 즉시 발행을 요청한 시장 기사 템플릿 id 대기열(봇이 꺼내 간다) */
  newsForceQueue: () => redisKey("news:force"),
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
/**
 * 보존 기간(prune-history `--candles-days`, 기본 30일)이 지난 1분 봉은 1시간 봉으로 합쳐 남긴다.
 * 1시간 이상 간격(1h·4h·1d)과 지수 "전체" 차트는 두 행을 함께 읽어 오래된 구간도 그대로 보인다.
 */
export const ROLLUP_CANDLE_INTERVAL = "1h";
export const ROLLUP_CANDLE_SECONDS = 3_600;

export function candleIntervalSeconds(id: string): number | null {
  return CANDLE_INTERVALS.find((interval) => interval.id === id)?.seconds ?? null;
}

/** 로그인 ID 겸 표시 이름. 이메일 없이 닉네임+비밀번호로 가입하므로 닉네임이 유일해야 한다. */
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;
/** 한글·영문·숫자·`_`·`-`·`.` 만. 공백·`@`를 막아 이메일과 헷갈리지 않게 한다. */
const NICKNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u;
export function normalizeNickname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}
export function isValidNickname(nickname: string): boolean {
  return nickname.length >= NICKNAME_MIN && nickname.length <= NICKNAME_MAX && NICKNAME_PATTERN.test(nickname);
}
export const NICKNAME_RULE_MESSAGE = `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자, 한글·영문·숫자·_ - . 만 쓸 수 있습니다`;
