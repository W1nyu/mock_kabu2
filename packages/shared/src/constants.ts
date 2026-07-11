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
export const STREAMS = {
  /** order-service → matching-engine (주문 접수/취소) */
  ORDERS: "streams:orders",
  /** matching-engine → account 정산 컨슈머 (체결/주문 종료) */
  TRADES: "streams:trades",
} as const;

/** Redis Pub/Sub 채널 */
export const CHANNELS = {
  /** 심볼별 호가 스냅샷: orderbook:{symbol} */
  orderbook: (symbol: string) => `orderbook:${symbol}`,
  /** 심볼별 체결: trades:{symbol} */
  trades: (symbol: string) => `trades:${symbol}`,
  /** 계정별 잔액/주문 변경 알림: account:{accountId} */
  account: (accountId: string) => `account:${accountId}`,
} as const;

/** Redis 캐시 키 */
export const KEYS = {
  /** 최신 호가 스냅샷 JSON — REST 초기 로딩용 */
  orderbookSnapshot: (symbol: string) => `snapshot:orderbook:${symbol}`,
} as const;

/** 컨슈머 그룹 이름 */
export const CONSUMER_GROUPS = {
  MATCHING: "matching-engine",
  SETTLEMENT: "settlement",
} as const;

/** 시장가 매수 주문의 잔액 홀드 안전 계수 (최근가 * qty * 계수) */
export const MARKET_BUY_HOLD_FACTOR = 1.1;
