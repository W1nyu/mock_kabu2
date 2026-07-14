import type { OrderClosedEvent } from "@mock-kabu/shared";

export interface SettlementOrderState {
  status: string;
  qty: number;
  filledQty: number;
}

const isActive = (status: string) => status === "OPEN" || status === "PARTIAL";
const isTerminal = (status: string) => ["FILLED", "CANCELED", "REJECTED"].includes(status);

/**
 * A close event carries the matching engine's aggregate fill count.  If the
 * local order row has not reached that count yet, its preceding trade events
 * have not all committed their reservation consumption.  Releasing the
 * remainder first would make a later trade decrement `hold_qty` below zero.
 */
export function closeMustWaitForTrades(
  order: SettlementOrderState,
  event: Pick<OrderClosedEvent, "filledQty">,
): boolean {
  return isActive(order.status) && event.filledQty > order.filledQty;
}

/**
 * close 이벤트가 먼저 DB 상태를 갱신한 경우에도, 뒤늦은 개별 체결이 filledQty를 한 번 더
 * 더하지 않게 한다. 활성 주문에서만 개별 체결 수량을 누적한다.
 */
export function stateAfterTrade(order: SettlementOrderState, fillQty: number) {
  const active = isActive(order.status);
  // settleTrade wraps every financial mutation in one database transaction.
  // A late trade after a terminal close must fail so that transaction rolls
  // back instead of consuming an already-released reservation a second time.
  if (!active) {
    throw new Error(`late trade targets terminal order: ${order.status}`);
  }
  const filledQty = order.filledQty + fillQty;
  if (filledQty > order.qty) {
    throw new Error(`overfill detected for order: ${filledQty}/${order.qty}`);
  }
  return {
    filledQty,
    status: filledQty >= order.qty ? "FILLED" : "PARTIAL",
  };
}

/**
 * 이미 종결됐거나 현재 수량보다 오래된 close 이벤트는 예약금을 재해제하지 않는다.
 * null은 해당 close 이벤트가 상태·예약금에 영향을 주지 않아야 함을 뜻한다.
 */
export function stateAfterClose(
  order: SettlementOrderState,
  event: Pick<OrderClosedEvent, "filledQty" | "status">,
) {
  if (isTerminal(order.status) || event.filledQty < order.filledQty) return null;
  const filledQty = Math.min(order.qty, event.filledQty);
  return { filledQty, status: event.status, remainingQty: order.qty - filledQty };
}
