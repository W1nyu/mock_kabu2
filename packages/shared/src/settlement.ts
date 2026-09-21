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

export interface HoldingCostState {
  qty: number;
  costBasis: bigint;
}

export interface SaleRealization {
  /** 이번 매도로 보유 원가에서 차감할 금액 (BigInt 내림) */
  basisReduction: bigint;
  /** 매도 대금 = 가격 × 수량 */
  proceeds: bigint;
  /** 실현손익 = 매도 대금 − 차감 원가 */
  realized: bigint;
}

/**
 * 매도 체결 한 건의 실현손익. 정산 컨슈머가 costBasis를 비례 차감하는 규칙과
 * 정확히 같은 내림 연산을 써야 누적 실현손익 + 남은 원가가 총 매입원가와 일치한다.
 * 보유가 0인 매도(레거시/봇 시드)는 원가 0으로 보고 대금 전체를 실현으로 잡는다.
 */
export function realizedPnlForSale(
  holding: HoldingCostState,
  sellQty: number,
  price: number,
): SaleRealization {
  const proceeds = BigInt(price) * BigInt(sellQty);
  const basisReduction =
    holding.qty > 0 ? (holding.costBasis * BigInt(sellQty)) / BigInt(holding.qty) : 0n;
  return { basisReduction, proceeds, realized: proceeds - basisReduction };
}
