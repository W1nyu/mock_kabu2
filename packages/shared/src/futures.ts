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
    // 최대 레버리지(20배)에 맞춘 5% — 거래소 기준 4.83%(20.7배)는 선택 가능한 상한을 넘는다.
    initialMarginBps: 500,
    maintenanceMarginBps: 333,
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
  // 2026-09-26 추가 상장 — 안전자산(금)과 농산물(옥수수)
  {
    symbol: "GOLDF",
    name: "금 선물",
    underlying: "GOLD",
    priceScale: 100,
    decimals: 2,
    tickUnits: 1,
    unitValue: 500,
    initialMarginBps: 1_000,
    maintenanceMarginBps: 666,
    initialPrice: 10_000,
    unit: "pt",
  },
  {
    symbol: "CORNF",
    name: "옥수수 선물",
    underlying: "CORN",
    priceScale: 100,
    decimals: 2,
    tickUnits: 1,
    unitValue: 500,
    initialMarginBps: 1_500,
    maintenanceMarginBps: 1_000,
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

/** 선택할 수 있는 최대 레버리지 */
export const MAX_FUTURES_LEVERAGE = 20;

/** 레버리지 값 검증: 1~20 정수, 또는 null(거래소 기준 증거금) */
export function isValidLeverage(leverage: unknown): leverage is number | null {
  return leverage === null || (Number.isInteger(leverage) && (leverage as number) >= 1 && (leverage as number) <= MAX_FUTURES_LEVERAGE);
}

/**
 * 증거금률(bps). 레버리지를 정하지 않으면(null) 상품의 거래소 기준 증거금률을 쓴다.
 * 레버리지 L이면 위탁증거금률 = 1/L(올림), 유지증거금률 = 위탁의 2/3 — 거래소 기준과 같은 비율이다.
 */
export function futureMarginBps(def: FutureDef, leverage: number | null | undefined): { initial: number; maintenance: number } {
  if (leverage == null) return { initial: def.initialMarginBps, maintenance: def.maintenanceMarginBps };
  const initial = Math.ceil(10_000 / leverage);
  return { initial, maintenance: Math.floor((initial * 2) / 3) };
}

/** 거래소 기준 증거금률을 레버리지 배수로 (표시용, 예: 21.75% → 4.6배) */
export function standardLeverage(def: FutureDef): number {
  return 10_000 / def.initialMarginBps;
}

/** 계약 1개의 위탁증거금(원) — 주문 시 묶는 단가 */
export function futureMarginPerContract(def: FutureDef, priceUnits: number, leverage?: number | null): bigint {
  return ceilBps(BigInt(priceUnits) * BigInt(def.unitValue), futureMarginBps(def, leverage).initial);
}

/**
 * 포지션 증거금(원) — 진입 금액(entryValue = Σ 진입가 × 계약 수, 정수 단위) 기준.
 * 체결마다 같은 식으로 다시 계산해 묶음의 증감을 정확히 되돌릴 수 있게 한다.
 */
export function futurePositionMargin(def: FutureDef, entryValue: bigint, leverage?: number | null): bigint {
  return ceilBps(entryValue * BigInt(def.unitValue), futureMarginBps(def, leverage).initial);
}

/** 유지증거금(원) — 평가 가격 기준 */
export function futureMaintenanceMargin(def: FutureDef, qty: number, markUnits: number, leverage?: number | null): bigint {
  return ceilBps(BigInt(Math.abs(qty)) * BigInt(markUnits) * BigInt(def.unitValue), futureMarginBps(def, leverage).maintenance);
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

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 일일 정산 시각: 매일 04:11 KST — 04:10 점검으로 주문이 막히고 1분 뒤(엔진이 남은 주문을 비울 여유). */
export const FUTURES_SETTLE_MINUTE_KST = 4 * 60 + 11;

/** 정산하는 거래일 키(KST 날짜 YYYY-MM-DD). 04:11 KST에 그날 날짜를 쓴다. */
export function futuresTradingDay(now: number): string {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** now 이후(같으면 포함하지 않음) 다음 정산 시각(epoch ms) */
export function nextFuturesSettlementAt(now: number): number {
  const kst = now + KST_OFFSET_MS;
  const dayStart = Math.floor(kst / 86_400_000) * 86_400_000;
  let at = dayStart + FUTURES_SETTLE_MINUTE_KST * 60_000;
  if (at <= kst) at += 86_400_000;
  return at - KST_OFFSET_MS;
}

/** 오늘 정산 시각이 이미 지났는지 — 재기동 때 놓친 정산을 따라잡는 데 쓴다. */
export function futuresSettlementDue(now: number): boolean {
  const kst = now + KST_OFFSET_MS;
  const dayStart = Math.floor(kst / 86_400_000) * 86_400_000;
  return kst >= dayStart + FUTURES_SETTLE_MINUTE_KST * 60_000;
}

/** 추가증거금 유예 시간 — 이 안에 위탁증거금 수준까지 채우지 않으면 반대매매한다. */
export const FUTURES_MARGIN_CALL_GRACE_MS = 30 * 60_000;
/** 한 포지션의 평가손실이 그 포지션 위탁증거금의 이 비율(bps)에 닿으면 유예 없이 전량 반대매매한다. */
export const FUTURES_EMERGENCY_LOSS_BPS = 9_000;

export interface FuturesRiskPosition {
  def: FutureDef;
  qty: number;
  entryValue: bigint;
  /** 포지션 위탁증거금(진입가 기준) */
  marginHeld: bigint;
  /** 현재가(정수 단위) */
  mark: number;
  /** 포지션 레버리지(null = 거래소 기준 증거금) */
  leverage?: number | null;
}

export interface FuturesRiskAssessment {
  /** 평가예탁금 = 현금 + 평가손익 − 미수금 */
  equity: bigint;
  unrealized: bigint;
  /** 현재가 기준 유지증거금 합계 */
  maintenance: bigint;
  /** 현재가 기준 위탁증거금 합계 — 추가증거금은 여기까지 채워야 해소된다 */
  initial: bigint;
  /** 평가예탁금이 유지증거금보다 작다 */
  belowMaintenance: boolean;
  /** 위탁증거금까지 모자란 금액(0 이상) */
  shortfall: bigint;
  /** 평가손실이 위탁증거금의 90%에 닿은 종목 */
  emergency: string[];
}

export function futureUnrealized(def: FutureDef, qty: number, entryValue: bigint, mark: number): bigint {
  if (qty === 0) return 0n;
  const markValue = BigInt(Math.abs(qty)) * BigInt(mark);
  return (qty > 0 ? 1n : -1n) * (markValue - entryValue) * BigInt(def.unitValue);
}

/** 계좌 하나의 선물 위험도. 현금은 현물과 공유하므로 잔액 전체를 평가예탁금에 넣는다. */
export function assessFuturesRisk(
  positions: readonly FuturesRiskPosition[],
  cash: { balance: bigint; debt: bigint },
): FuturesRiskAssessment {
  let unrealized = 0n;
  let maintenance = 0n;
  let initial = 0n;
  const emergency: string[] = [];
  for (const p of positions) {
    if (p.qty === 0) continue;
    const pnl = futureUnrealized(p.def, p.qty, p.entryValue, p.mark);
    unrealized += pnl;
    maintenance += futureMaintenanceMargin(p.def, p.qty, p.mark, p.leverage);
    initial += futureMarginPerContract(p.def, p.mark, p.leverage) * BigInt(Math.abs(p.qty));
    if (p.marginHeld > 0n && -pnl * 10_000n >= p.marginHeld * BigInt(FUTURES_EMERGENCY_LOSS_BPS)) emergency.push(p.def.symbol);
  }
  const equity = cash.balance + unrealized - cash.debt;
  const shortfall = initial > equity ? initial - equity : 0n;
  return { equity, unrealized, maintenance, initial, belowMaintenance: equity < maintenance, shortfall, emergency };
}

/**
 * 기한 초과 반대매매 수량: 추가증거금 ÷ 위탁증거금 비율만큼(올림) 줄이면 남은 위탁증거금을 평가예탁금이 감당한다.
 * 평가예탁금이 0 이하면 전량.
 */
export function marginCallLiquidationQty(qty: number, shortfall: bigint, initial: bigint): number {
  const size = Math.abs(qty);
  if (size === 0 || shortfall <= 0n) return 0;
  if (initial <= 0n || shortfall >= initial) return size;
  const n = (BigInt(size) * shortfall + initial - 1n) / initial;
  return Math.max(1, Math.min(size, Number(n)));
}
