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
