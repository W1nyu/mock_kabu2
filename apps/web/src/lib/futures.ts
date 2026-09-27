import { formatWon, futureDef, standardLeverage } from "@mock-kabu/shared";
import { getLocale, translate } from "./i18n";
import { fmtOption, type OptionPosition } from "./options";

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
  /** 등락률 기준가 = 직전 일일 정산가(없으면 이번 계약 첫 체결가) */
  base: number;
  /** 직전 일일 정산가, 없으면 null */
  settlementPrice?: number | null;
  /** 이번 계약 정산 시각(epoch ms) */
  settlesAt?: number;
  underlying: number | null;
  /** 이번 계약(직전 04:11 이후) 거래량 */
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
    /** 1~20배, null = 거래소 기준 증거금 */
    leverage: number | null;
    /** LONG/SHORT(사람 계정 양방향), NET(봇) */
    positionSide: "LONG" | "SHORT" | "NET";
    /** 지금 청산 주문을 더 낼 수 있는 계약 수(보유 − 걸린 청산 미체결) */
    closableQty: number;
  }[];
  marginHeld: number;
  debt: number;
  unrealized: number;
  maintenanceMargin: number;
  /** 현재가 기준 위탁증거금 합계 — 추가증거금은 여기까지 채워야 해소된다 */
  initialMargin: number;
  equity: number;
  /** 종목별 레버리지 설정(포지션이 없어도), null = 거래소 기준 */
  leverage: Record<string, number | null>;
  marginCall: { startedAt: string; deadline: string; required: number; shortfall: number } | null;
  liquidations: { orderId: string; symbol: string; side: "BUY" | "SELL"; qty: number; reason: "DEADLINE" | "EMERGENCY"; createdAt: string }[];
  /** 옵션 포지션(선물과 같은 API) */
  options?: OptionPosition[];
  /** 옵션 평가액 합계(최근가 × 수량 × 승수) — 총 자산에 더한다 */
  optionsValue?: number;
}

export function fmtFuture(symbol: string, units: number | null | undefined): string {
  const def = futureDef(symbol);
  // 옵션도 같은 호가창·체결 표시를 쓰므로 선물이 아니면 옵션 표기로 넘긴다.
  if (!def) return fmtOption(symbol, units);
  if (units == null || !Number.isFinite(units)) return "—";
  const text = (units / def.priceScale).toLocaleString("ko-KR", {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  });
  return def.unit === "원" ? formatWon(text, getLocale()) : text;
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

export const krw = (n: number) => formatWon(Math.round(n).toLocaleString("ko-KR"), getLocale());

/** 레버리지 표시: 설정값 "20배", 없으면 거래소 기준 "4.6배(기본)" */
export function leverageLabel(symbol: string, leverage: number | null | undefined): string {
  if (leverage != null) return translate(getLocale(), "{n}배", { n: leverage });
  const def = futureDef(symbol);
  return def ? translate(getLocale(), "{n}배(기본)", { n: standardLeverage(def).toFixed(1) }) : "—";
}

/** 레버리지 선택지 */
export const LEVERAGE_CHOICES = [1, 2, 3, 5, 10, 15, 20] as const;
