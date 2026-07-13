import type { OrderSide, OrderStatus, OrderType } from "./types";

/** streams:orders 에 실리는 이벤트 */
export type OrderStreamEvent = OrderPlacedEvent | OrderCancelRequestedEvent;

export interface OrderPlacedEvent {
  topic: "order.placed";
  eventId: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** LIMIT 지정가. MARKET이면 null */
  price: number | null;
  qty: number;
  ts: number;
}

export interface OrderCancelRequestedEvent {
  topic: "order.cancel.requested";
  eventId: string;
  orderId: string;
  symbol: string;
  ts: number;
}

/** streams:trades 에 실리는 이벤트 */
export type TradeStreamEvent = TradeExecutedEvent | OrderClosedEvent;

export interface TradeExecutedEvent {
  topic: "trade.executed";
  eventId: string;
  tradeId: string;
  symbol: string;
  price: number;
  qty: number;
  buyOrderId: string;
  sellOrderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  takerSide: OrderSide;
  ts: number;
}

/**
 * 주문이 종료(FILLED/CANCELED/REJECTED)되어 남은 홀드를 해제해야 할 때.
 * 체결로 인한 정산과 별개로, 잔여 홀드 반환의 트리거가 된다.
 */
export interface OrderClosedEvent {
  topic: "order.closed";
  eventId: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  filledQty: number;
  status: Extract<OrderStatus, "FILLED" | "CANCELED" | "REJECTED">;
  reason?: string;
  ts: number;
}
