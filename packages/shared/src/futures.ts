import type { ReferenceCode } from "./reference";

/**
 * 1일물 선물 5종(설계: docs/superpowers/specs/2026-09-25-futures-design.md).
 *
 * 가격은 모두 **정수 단위**다: 실제 가격 × priceScale. 매칭엔진·주문·체결은 이 정수를 현물 가격처럼 다룬다.
 *   예) KABUF 880.05pt → 88005 (scale 100), USDF 1,400.1원 → 14001 (scale 10)
 * `unitValue`는 가격 1단위가 계약 1개에서 몇 원인지다(= 승수 ÷ scale).
 *   예) KABUF 1pt = 10,000원 → 1단위(0.01pt) = 100원
 */
export type FutureUnderlying = "KABU_INDEX" | ReferenceCode;

export interface FutureDef {
  symbol: string;
  name: string;
  underlying: FutureUnderlying;
  /** 저장 가격 = 실제 가격 × priceScale */
  priceScale: number;
  /** 화면 소수 자리 */
  decimals: number;
  /** 호가 단위(정수 단위) */
  tickUnits: number;
  /** 가격 1단위 × 계약 1개 = 원 */
  unitValue: number;
  /** 위탁(개시)증거금률, 1/10000 */
  initialMarginBps: number;
  /** 유지증거금률, 1/10000 (위탁의 2/3) */
  maintenanceMarginBps: number;
  /** 첫 상장가(정수 단위) */
  initialPrice: number;
  /** 화면 단위 */
  unit: "pt" | "원";
}

export const FUTURES: readonly FutureDef[] = [
  {
    symbol: "KABUF",
    name: "KABU 지수 선물",
    underlying: "KABU_INDEX",
    priceScale: 100,
    decimals: 2,
    tickUnits: 5,
    unitValue: 100,
    initialMarginBps: 2_175,
    maintenanceMarginBps: 1_450,
    initialPrice: 88_000,
    unit: "pt",
  },
  {
    symbol: "USDF",
    name: "원/달러 선물",
    underlying: "USDKRW",
    priceScale: 10,
    decimals: 1,
    tickUnits: 1,
    unitValue: 1_000,
    initialMarginBps: 483,
    maintenanceMarginBps: 322,
    initialPrice: 14_000,
    unit: "원",
  },
  {
    symbol: "OILF",
    name: "원유 선물",
    underlying: "OIL",
    priceScale: 100,
    decimals: 2,
    tickUnits: 1,
    unitValue: 500,
    initialMarginBps: 1_650,
    maintenanceMarginBps: 1_100,
    initialPrice: 10_000,
    unit: "pt",
  },
  {
    symbol: "GASF",
    name: "천연가스 선물",
    underlying: "GAS",
    priceScale: 100,
    decimals: 2,
    tickUnits: 1,
    unitValue: 500,
    initialMarginBps: 2_250,
    maintenanceMarginBps: 1_500,
    initialPrice: 10_000,
    unit: "pt",
  },
  {
    symbol: "CPRF",
    name: "구리 선물",
    underlying: "COPPER",
    priceScale: 100,
    decimals: 2,
    tickUnits: 1,
    unitValue: 500,
    initialMarginBps: 1_350,
    maintenanceMarginBps: 900,
    initialPrice: 10_000,
    unit: "pt",
  },
];

/** 선물 한 주문의 계약 수 상한 — 모의 거래에서 한 번에 과도한 레버리지를 막는다. */
export const MAX_FUTURES_ORDER_QTY = 100;

const BY_SYMBOL = new Map(FUTURES.map((future) => [future.symbol, future]));

export function futureDef(symbol: string): FutureDef | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

export function isFuture(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

/** ceil(a × b / 10000) — 증거금은 원 단위 올림 */
function ceilBps(value: bigint, bps: number): bigint {
  const numerator = value * BigInt(bps);
  return (numerator + 9_999n) / 10_000n;
}

/** 계약 1개의 위탁증거금(원) — 주문 시 묶는 단가 */
export function futureMarginPerContract(def: FutureDef, priceUnits: number): bigint {
  return ceilBps(BigInt(priceUnits) * BigInt(def.unitValue), def.initialMarginBps);
}

/**
 * 포지션 증거금(원) — 진입 금액(entryValue = Σ 진입가 × 계약 수, 정수 단위) 기준.
 * 체결마다 같은 식으로 다시 계산해 묶음의 증감을 정확히 되돌릴 수 있게 한다.
 */
export function futurePositionMargin(def: FutureDef, entryValue: bigint): bigint {
  return ceilBps(entryValue * BigInt(def.unitValue), def.initialMarginBps);
}

/** 유지증거금(원) — 평가 가격 기준 */
export function futureMaintenanceMargin(def: FutureDef, qty: number, markUnits: number): bigint {
  return ceilBps(BigInt(Math.abs(qty)) * BigInt(markUnits) * BigInt(def.unitValue), def.maintenanceMarginBps);
}

export interface FuturePositionState {
  /** 부호 있는 계약 수: + 매수(롱), − 매도(숏) */
  qty: number;
  /** 열린 계약의 진입 금액 합 Σ(진입가 × 계약 수), 정수 단위, 항상 ≥ 0 */
  entryValue: bigint;
}

export interface FutureFillResult extends FuturePositionState {
  /** 이번 체결로 청산된 계약 수 */
  closedQty: number;
  /** 실현손익(원) */
  realized: bigint;
}

/**
 * 포지션에 체결 하나를 적용한다. 같은 방향이면 진입 금액을 더하고, 반대 방향이면 먼저 청산한 뒤
 * 남는 수량으로 반대 포지션을 연다. 청산 원가는 현물 매도와 같은 비례 내림(entryValue × k / |qty|)이라
 * 누적 실현손익 + 남은 진입 금액이 총 진입 금액과 정확히 맞는다.
 */
export function applyFutureFill(
  def: FutureDef,
  position: FuturePositionState,
  side: "BUY" | "SELL",
  price: number,
  fillQty: number,
): FutureFillResult {
  const delta = side === "BUY" ? fillQty : -fillQty;
  const { qty, entryValue } = position;
  if (qty === 0 || Math.sign(qty) === Math.sign(delta)) {
    return { qty: qty + delta, entryValue: entryValue + BigInt(price) * BigInt(fillQty), closedQty: 0, realized: 0n };
  }
  const closedQty = Math.min(fillQty, Math.abs(qty));
  const basis = (entryValue * BigInt(closedQty)) / BigInt(Math.abs(qty));
  const direction = qty > 0 ? 1n : -1n;
  const realizedUnits = direction * (BigInt(price) * BigInt(closedQty) - basis);
  const remainingOpen = fillQty - closedQty;
  const nextQty = qty + Math.sign(delta) * closedQty;
  const nextEntry = entryValue - basis;
  if (remainingOpen === 0) {
    return { qty: nextQty, entryValue: nextQty === 0 ? 0n : nextEntry, closedQty, realized: realizedUnits * BigInt(def.unitValue) };
  }
  // 전량 청산 후 남는 수량으로 반대 포지션을 연다.
  return {
    qty: Math.sign(delta) * remainingOpen,
    entryValue: BigInt(price) * BigInt(remainingOpen),
    closedQty,
    realized: realizedUnits * BigInt(def.unitValue),
  };
}

/** 정수 단위 → 화면 문자열 */
export function formatFuturePrice(def: FutureDef, units: number): string {
  const text = (units / def.priceScale).toLocaleString("ko-KR", {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  });
  return def.unit === "원" ? `${text}원` : text;
}

export interface FuturesCashState {
  balance: bigint;
  /** 이번 체결의 주문 증거금 해제까지 반영한 묶음 금액 */
  holdAmount: bigint;
  debt: bigint;
}

export interface FuturesCashResult {
  balance: bigint;
  debt: bigint;
  /** 원장에 남길 잔액 변화(0이면 원장 행 없음) */
  ledgerDelta: bigint;
}

/**
 * 선물 실현손익을 현금에 반영한다. 잔액은 음수가 될 수 없고 주문 묶음보다 작아질 수 없으므로(DB 제약),
 * 손실은 (잔액 − 묶음)까지만 현금에서 빼고 나머지는 미수금으로 쌓는다. 이익은 미수금부터 갚는다.
 */
export function applyFuturesCash(state: FuturesCashState, realized: bigint): FuturesCashResult {
  if (realized >= 0n) {
    const repay = realized < state.debt ? realized : state.debt;
    return { balance: state.balance + realized - repay, debt: state.debt - repay, ledgerDelta: realized - repay };
  }
  const loss = -realized;
  const room = state.balance - state.holdAmount;
  const paid = loss < room ? loss : room > 0n ? room : 0n;
  return { balance: state.balance - paid, debt: state.debt + (loss - paid), ledgerDelta: -paid };
}
