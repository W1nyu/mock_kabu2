import type { OrderSide, OrderType } from "./types";

/** 조건부(예약) 주문의 발동 방향. 현재가가 트리거 가격 이상/이하가 되는 순간 발동한다. */
export type TriggerDirection = "AT_OR_ABOVE" | "AT_OR_BELOW";

export type ConditionalOrderStatus = "WAITING" | "TRIGGERED" | "CANCELED" | "FAILED";

export interface ConditionalOrderDto {
  id: string;
  symbol: string;
  side: OrderSide;
  direction: TriggerDirection;
  triggerPrice: number;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
  /** 양방향 선물 예약의 청산 방향 LONG | SHORT. null/undefined = 순포지션(봇·옵션·현물) */
  positionSide?: string | null;
  /** OCO 짝 그룹. 같은 그룹의 한 행이 발동하면 나머지는 자동 취소 */
  ocoGroupId: string | null;
  /** 트레일링 거리(bps). null이면 고정 트리거 */
  trailBps: number | null;
  /** 트레일링 기준 극값(매도 고점/매수 저점). 고정 트리거면 null */
  watermark: number | null;
  status: ConditionalOrderStatus;
  /** 발동 시 접수된 실제 주문 ID (접수 실패 시 null) */
  triggeredOrderId: string | null;
  /** 발동을 일으킨 체결가 */
  triggerTradePrice: number | null;
  failReason: string | null;
  triggeredAt: string | null;
  createdAt: string;
}

/** 매수 주문에 붙인 "체결 후 손절/익절 자동 등록" 의도. */
export interface BracketIntentDto {
  id: string;
  orderId: string;
  symbol: string;
  /** null이면 손절 없음 */
  stopBps: number | null;
  /** null이면 익절 없음 */
  takeBps: number | null;
  status: "PENDING" | "ARMED" | "CANCELED";
  armedQty: number;
  avgFillPrice: number | null;
  note: string | null;
  createdAt: string;
}

/** 체결가 하나가 조건을 만족하는지. 경계값 포함(이상/이하). */
export function conditionMet(direction: TriggerDirection, triggerPrice: number, price: number): boolean {
  return direction === "AT_OR_ABOVE" ? price >= triggerPrice : price <= triggerPrice;
}

/**
 * 기준가 대비 트리거 위치로 자연스러운 방향을 고른다. 트리거가 현재가보다 위면 "이상",
 * 아래면 "이하". 같은 값이면 매도는 손절(이하), 매수는 돌파(이상)로 본다.
 */
export function inferTriggerDirection(
  triggerPrice: number,
  referencePrice: number,
  side: OrderSide,
): TriggerDirection {
  if (triggerPrice > referencePrice) return "AT_OR_ABOVE";
  if (triggerPrice < referencePrice) return "AT_OR_BELOW";
  return side === "SELL" ? "AT_OR_BELOW" : "AT_OR_ABOVE";
}

/** 사람이 읽는 조건 설명. UI와 서버 로그가 같은 문구를 쓴다. */
export function describeCondition(direction: TriggerDirection, side: OrderSide): string {
  if (side === "SELL") return direction === "AT_OR_BELOW" ? "손절 매도" : "익절 매도";
  return direction === "AT_OR_ABOVE" ? "돌파 매수" : "눌림 매수";
}

/** 트레일링 스탑 거리 한계 (basis points). 0.1% ~ 50%. */
export const TRAIL_BPS_MIN = 10;
export const TRAIL_BPS_MAX = 5_000;

/**
 * 트레일링 스탑의 현재 트리거 가격. 매도는 고점(watermark)에서 bps만큼 아래(내림),
 * 매수는 저점에서 bps만큼 위(올림). 정수 가격만 쓰는 시장이라 항상 정수를 돌려준다.
 */
export function trailingTrigger(side: OrderSide, watermark: number, trailBps: number): number {
  const ratio = trailBps / 10_000;
  return side === "SELL"
    ? Math.max(1, Math.floor(watermark * (1 - ratio)))
    : Math.max(1, Math.ceil(watermark * (1 + ratio)));
}

/**
 * 새 체결가가 추적 기준(고점/저점)을 갱신하는지. 매도 트레일링은 더 높은 가격만,
 * 매수 트레일링은 더 낮은 가격만 기준을 옮긴다.
 */
export function advancesWatermark(side: OrderSide, watermark: number, price: number): boolean {
  return side === "SELL" ? price > watermark : price < watermark;
}
