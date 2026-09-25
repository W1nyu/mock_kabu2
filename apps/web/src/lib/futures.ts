import { futureDef, formatFuturePrice } from "@mock-kabu/shared";

/** `/market/futures` 한 줄 (가격은 모두 정수 단위 = 실제 × priceScale) */
export interface FutureRow {
  symbol: string;
  name: string;
  unit: string;
  priceScale: number;
  decimals: number;
  tickUnits: number;
  unitValue: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  lastPrice: number;
  base: number;
  underlying: number | null;
  volume: number;
}

/** `/account/futures` (원 단위 금액은 API가 숫자로 내보낸다) */
export interface FuturesAccount {
  positions: {
    symbol: string;
    qty: number;
    avgPrice: number;
    markPrice: number;
    unrealized: number;
    marginHeld: number;
    maintenanceMargin: number;
  }[];
  marginHeld: number;
  debt: number;
  unrealized: number;
  maintenanceMargin: number;
  equity: number;
}

export function fmtFuture(symbol: string, units: number | null | undefined): string {
  const def = futureDef(symbol);
  if (!def || units == null || !Number.isFinite(units)) return "—";
  return formatFuturePrice(def, units);
}

export function changePct(value: number | null | undefined, base: number | null | undefined): number | null {
  if (value == null || base == null || base <= 0) return null;
  return ((value - base) / base) * 100;
}

/** 입력한 가격(실제값) → 정수 단위, 호가 단위에 맞지 않으면 null */
export function toFutureUnits(symbol: string, text: string): number | null {
  const def = futureDef(symbol);
  const value = Number(text.replace(/,/g, ""));
  if (!def || !Number.isFinite(value) || value <= 0) return null;
  const units = Math.round(value * def.priceScale);
  return units % def.tickUnits === 0 ? units : null;
}

export function unitsToInput(symbol: string, units: number): string {
  const def = futureDef(symbol);
  return def ? (units / def.priceScale).toFixed(def.decimals) : String(units);
}

export const krw = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
