import type { OrderClosedEvent } from "./events";

export interface SettlementOrderState {
  status: string;
  qty: number;
  filledQty: number;
}

const isActive = (status: string) => status === "OPEN" || status === "PARTIAL";
const isTerminal = (status: string) => ["FILLED", "CANCELED", "REJECTED"].includes(status);

/**
 * A close event carries the matching engine's aggregate fill count. If the
 * local order row has not reached that count yet, preceding trade events have
 * not all committed their reservation consumption. Releasing holds first
 * would let a later trade push a reservation below zero.
 */
export function closeMustWaitForTrades(
  order: SettlementOrderState,
  event: Pick<OrderClosedEvent, "filledQty">,
): boolean {
  return isActive(order.status) && event.filledQty > order.filledQty;
}

/** Advance an active order by one durable trade without accepting overfills. */
export function stateAfterTrade(order: SettlementOrderState, fillQty: number) {
  if (!isActive(order.status)) {
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
 * An already terminal order, or a stale close event, must not release a hold
 * for a second time. Null means this event has no state-transition effect.
 */
export function stateAfterClose(
  order: SettlementOrderState,
  event: Pick<OrderClosedEvent, "filledQty" | "status">,
) {
  if (isTerminal(order.status) || event.filledQty < order.filledQty) return null;
  const filledQty = Math.min(order.qty, event.filledQty);
  return { filledQty, status: event.status, remainingQty: order.qty - filledQty };
}
