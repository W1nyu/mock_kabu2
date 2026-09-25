export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";
export type LockStrategy = "optimistic" | "pessimistic" | "distributed";

export interface OrderbookLevel {
  price: number;
  qty: number;
}

export interface OrderbookSnapshot {
  symbol: string;
  bids: OrderbookLevel[]; // 가격 내림차순
  asks: OrderbookLevel[]; // 가격 오름차순
  lastPrice: number | null;
  seq: number;
  ts: number;
}

export interface TradeTick {
  tradeId: string;
  symbol: string;
  price: number;
  qty: number;
  /** 테이커 방향 (차트 색상용) */
  takerSide: OrderSide;
  ts: number;
}

export interface CandleDto {
  symbol: string;
  interval: string;
  ts: number; // 버킷 시작 epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A published news story as the browser sees it.
 *
 * Deliberately carries no sentiment and no impact strength: the UI shows a
 * headline, a symbol and a time, and the reader judges the rest. Those fields
 * exist in the database but must never enter this DTO, or the network tab
 * would give away what the feed is designed not to say.
 */
export interface NewsItemDto {
  id: string;
  /** null for an industry or market-wide story. */
  symbol: string | null;
  symbolName: string | null;
  /** Industry id (INDUSTRIES) for an industry story; null otherwise. */
  industry: string | null;
  category: string;
  headline: string;
  body: string | null;
  /** epoch ms */
  ts: number;
}
