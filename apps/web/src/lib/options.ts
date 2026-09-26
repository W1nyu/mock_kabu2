import { optionDef } from "@mock-kabu/shared";

/** `/market/options` 한 줄 (가격은 모두 정수 단위 = 실제 × priceScale) */
export interface OptionRow {
  symbol: string;
  family: string;
  /** 거래 종료(보유분 매도·만기 정산만) */
  retired?: boolean;
  familyName: string;
  type: "CALL" | "PUT";
  slot: number;
  name: string;
  strike: number | null;
  underlying: number | null;
  theo: number | null;
  lastPrice: number;
  priceScale: number;
  decimals: number;
  unit: string;
  tickUnits: number;
  unitValue: number;
  expiresAt: number;
}

/** `/account/futures`의 `options` 한 줄 */
export interface OptionPosition {
  symbol: string;
  name: string;
  type: "CALL" | "PUT";
  strike: number | null;
  qty: number;
  avgPrice: number;
  lastPrice: number;
  theo: number | null;
  value: number;
  unrealized: number;
  marginHeld: number;
}

/** 옵션 가격(정수 단위) → "12.35" / "3.1원" */
export function fmtOption(symbol: string, units: number | null | undefined): string {
  const def = optionDef(symbol);
  if (!def || units == null || !Number.isFinite(units)) return "—";
  const text = (units / def.priceScale).toLocaleString("ko-KR", {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  });
  return def.unit === "원" ? `${text}원` : text;
}

/** 행사가 표기 — 주가지수 "2,510", 원/달러 "1,405원" (행사가 간격이 정수라 소수점 없이) */
export function fmtStrike(symbol: string, units: number | null | undefined): string {
  const def = optionDef(symbol);
  if (!def || units == null) return "—";
  const text = (units / def.priceScale).toLocaleString("ko-KR", { maximumFractionDigits: def.decimals });
  return def.unit === "원" ? `${text}원` : text;
}

/** "주가지수 콜 2,510" — 종목 이름(자리 번호) 대신 행사가를 붙인 화면용 이름 */
export function optionLabel(symbol: string, strike: number | null | undefined): string {
  const def = optionDef(symbol);
  if (!def) return symbol;
  return `${def.family.name} ${def.type === "CALL" ? "콜" : "풋"} ${fmtStrike(symbol, strike)}`;
}

/** 만기까지 남은 시간 "5시간 12분" */
export function timeLeft(expiresAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((expiresAt - now) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}
