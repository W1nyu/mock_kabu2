import type { OrderSide, OrderType, OrderbookLevel } from "@mock-kabu/shared";

export interface IncomingOrder {
  orderId: string;
  accountId: string;
  side: OrderSide;
  type: OrderType;
  /** LIMIT 지정가, MARKET이면 null */
  price: number | null;
  qty: number;
  ts: number;
}

export interface RestingOrder {
  orderId: string;
  accountId: string;
  side: OrderSide;
  price: number;
  /** 남은 수량 */
  qty: number;
  /** 총 주문 수량 (체결 누계 계산용) */
  totalQty: number;
  /** 도착 순서 (시간 우선) */
  seq: number;
}

export interface Fill {
  price: number; // 메이커(먼저 있던 주문) 가격
  qty: number;
  makerOrderId: string;
  makerAccountId: string;
  takerOrderId: string;
  takerAccountId: string;
  takerSide: OrderSide;
}

export interface ClosedOrder {
  orderId: string;
  accountId: string;
  side: OrderSide;
  filledQty: number;
  status: "FILLED" | "CANCELED";
}

export interface MatchResult {
  fills: Fill[];
  /** LIMIT 잔량이 북에 올라간 수량 */
  restingQty: number;
  /** MARKET(IOC) 잔량으로 취소된 수량 */
  canceledQty: number;
  /** 이번 매칭으로 완전히 종료된 주문들 (잔여 홀드 해제 트리거) */
  closedOrders: ClosedOrder[];
}

export interface Orderbook {
  symbol: string;
  /** 가격 내림차순, 같은 가격은 seq 오름차순 */
  bids: RestingOrder[];
  /** 가격 오름차순, 같은 가격은 seq 오름차순 */
  asks: RestingOrder[];
  lastPrice: number | null;
  seq: number;
}

export function createBook(symbol: string, lastPrice: number | null = null): Orderbook {
  return { symbol, bids: [], asks: [], lastPrice, seq: 0 };
}

/** 정렬 기준을 지키며 삽입: bids는 가격 내림차순, asks는 오름차순, 동가는 seq 오름차순 */
function insertResting(book: Orderbook, order: RestingOrder): void {
  const list = order.side === "BUY" ? book.bids : book.asks;
  const better =
    order.side === "BUY"
      ? (a: RestingOrder) => a.price > order.price
      : (a: RestingOrder) => a.price < order.price;

  let i = 0;
  while (i < list.length && (better(list[i]) || list[i].price === order.price)) i++;
  list.splice(i, 0, order);
}

/** 가격-시간 우선 매칭. LIMIT 잔량은 북에 등재, MARKET 잔량은 취소(IOC). */
export function applyOrder(book: Orderbook, incoming: IncomingOrder): MatchResult {
  const result: MatchResult = { fills: [], restingQty: 0, canceledQty: 0, closedOrders: [] };
  const opposite = incoming.side === "BUY" ? book.asks : book.bids;
  let remaining = incoming.qty;

  const crosses = (maker: RestingOrder): boolean => {
    // MARKET에 price가 있으면 보호 상한/하한(홀드 초과 체결 방지)으로 사용
    if (incoming.type === "MARKET" && incoming.price == null) return true;
    return incoming.side === "BUY"
      ? maker.price <= incoming.price!
      : maker.price >= incoming.price!;
  };

  while (remaining > 0 && opposite.length > 0 && crosses(opposite[0])) {
    const maker = opposite[0];
    const qty = Math.min(remaining, maker.qty);

    result.fills.push({
      price: maker.price,
      qty,
      makerOrderId: maker.orderId,
      makerAccountId: maker.accountId,
      takerOrderId: incoming.orderId,
      takerAccountId: incoming.accountId,
      takerSide: incoming.side,
    });

    maker.qty -= qty;
    remaining -= qty;
    book.lastPrice = maker.price;

    if (maker.qty === 0) {
      opposite.shift();
      result.closedOrders.push({
        orderId: maker.orderId,
        accountId: maker.accountId,
        side: maker.side,
        filledQty: maker.totalQty,
        status: "FILLED",
      });
    }
  }

  const filledQty = incoming.qty - remaining;

  if (remaining === 0) {
    result.closedOrders.push({
      orderId: incoming.orderId,
      accountId: incoming.accountId,
      side: incoming.side,
      filledQty: incoming.qty,
      status: "FILLED",
    });
  } else if (incoming.type === "MARKET") {
    // IOC: 시장가 잔량은 취소
    result.canceledQty = remaining;
    result.closedOrders.push({
      orderId: incoming.orderId,
      accountId: incoming.accountId,
      side: incoming.side,
      filledQty,
      status: "CANCELED",
    });
  } else {
    // LIMIT 잔량 등재
    book.seq++;
    insertResting(book, {
      orderId: incoming.orderId,
      accountId: incoming.accountId,
      side: incoming.side,
      price: incoming.price!,
      qty: remaining,
      totalQty: incoming.qty,
      seq: book.seq,
    });
    result.restingQty = remaining;
  }

  return result;
}

/** 북에서 주문 제거. 있으면 제거된 주문을 반환 */
export function cancelOrder(book: Orderbook, orderId: string): RestingOrder | null {
  for (const list of [book.bids, book.asks]) {
    const idx = list.findIndex((o) => o.orderId === orderId);
    if (idx >= 0) {
      return list.splice(idx, 1)[0];
    }
  }
  return null;
}

/** 가격 레벨 집계 스냅샷 (호가창) */
export function levels(
  book: Orderbook,
  depth: number,
): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
  const aggregate = (list: RestingOrder[]): OrderbookLevel[] => {
    const out: OrderbookLevel[] = [];
    for (const o of list) {
      const last = out[out.length - 1];
      if (last && last.price === o.price) {
        last.qty += o.qty;
      } else {
        if (out.length === depth) break;
        out.push({ price: o.price, qty: o.qty });
      }
    }
    return out;
  };
  return { bids: aggregate(book.bids), asks: aggregate(book.asks) };
}
