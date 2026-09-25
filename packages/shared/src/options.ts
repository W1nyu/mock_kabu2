/**
 * 1일물 옵션 — 주가지수 옵션·원/달러 옵션 (설계 docs/superpowers/specs/2026-09-26-options-design.md).
 *
 * 종목 이름은 고정(`KC3` = 주가지수 콜 3번)이고 행사가만 매일 04:11 정산 뒤 등가격 기준으로 다시 깐다.
 * 가격은 모두 기초자산과 같은 정수 단위(실제 × priceScale)다. 1계약의 원화 가치 = 가격 단위 × unitValue.
 */
export type OptionType = "CALL" | "PUT";
export type OptionFamilyCode = "K" | "U";

export interface OptionFamilyDef {
  code: OptionFamilyCode;
  name: string;
  /** 기초자산 가격과 결제가를 가져오는 선물(같은 단위) */
  future: "KABUF" | "USDF";
  priceScale: number;
  decimals: number;
  unit: "pt" | "원";
  /** 프리미엄 호가 단위(정수 단위) */
  tickUnits: number;
  /** 가격 1단위 × 1계약 = 원 */
  unitValue: number;
  /** 행사가 간격(정수 단위) */
  strikeStepUnits: number;
  /** 이론가 계산용 하루 변동성(로그수익률 표준편차) */
  dailyVol: number;
  /** 쓰기(매도로 새로 연) 포지션의 계약당 증거금 = 행사가 명목 × 이 비율(bps) */
  writerMarginBps: number;
  /** 마켓메이커 예약 계정 배정용 이름(LIQUIDITY_RESERVE_ORDER) */
  reserve: string;
}

export const OPTION_FAMILIES: readonly OptionFamilyDef[] = [
  {
    code: "K",
    name: "주가지수",
    future: "KABUF",
    priceScale: 100,
    decimals: 2,
    unit: "pt",
    tickUnits: 5,
    unitValue: 100,
    strikeStepUnits: 1_000,
    dailyVol: 0.012,
    writerMarginBps: 800,
    reserve: "OPT_KABU",
  },
  {
    code: "U",
    name: "원/달러",
    future: "USDF",
    priceScale: 10,
    decimals: 1,
    unit: "원",
    tickUnits: 1,
    unitValue: 1_000,
    strikeStepUnits: 50,
    dailyVol: 0.005,
    writerMarginBps: 300,
    reserve: "OPT_USD",
  },
];

/** 행사가 자리: 3이 등가격, 1·2는 아래, 4·5는 위 */
export const OPTION_SLOTS = [1, 2, 3, 4, 5] as const;
export const OPTION_ATM_SLOT = 3;

export interface OptionDef {
  symbol: string;
  family: OptionFamilyDef;
  type: OptionType;
  slot: number;
  /** 화면 이름(행사가는 매일 바뀌므로 따로 붙인다) — 예: "주가지수 콜 3" */
  name: string;
  priceScale: number;
  decimals: number;
  unit: "pt" | "원";
  tickUnits: number;
  unitValue: number;
}

export const OPTIONS: readonly OptionDef[] = OPTION_FAMILIES.flatMap((family) =>
  (["CALL", "PUT"] as const).flatMap((type) =>
    OPTION_SLOTS.map((slot) => ({
      symbol: `${family.code}${type === "CALL" ? "C" : "P"}${slot}`,
      family,
      type,
      slot,
      name: `${family.name} ${type === "CALL" ? "콜" : "풋"} ${slot}`,
      priceScale: family.priceScale,
      decimals: family.decimals,
      unit: family.unit,
      tickUnits: family.tickUnits,
      unitValue: family.unitValue,
    })),
  ),
);

const BY_SYMBOL = new Map(OPTIONS.map((option) => [option.symbol, option]));

export function optionDef(symbol: string): OptionDef | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

export function isOption(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

export function optionFamily(code: string): OptionFamilyDef | null {
  return OPTION_FAMILIES.find((family) => family.code === code) ?? null;
}

/** 등가격 행사가 = 기초자산을 행사가 간격에 맞춰 반올림 */
export function atmStrike(family: OptionFamilyDef, underlyingUnits: number): number {
  return Math.max(family.strikeStepUnits, Math.round(underlyingUnits / family.strikeStepUnits) * family.strikeStepUnits);
}

/** 자리별 행사가(정수 단위) */
export function strikeForSlot(family: OptionFamilyDef, atm: number, slot: number): number {
  return Math.max(family.strikeStepUnits, atm + (slot - OPTION_ATM_SLOT) * family.strikeStepUnits);
}

/** 내재가치(정수 단위): 콜 max(S−K, 0), 풋 max(K−S, 0) */
export function optionIntrinsic(type: OptionType, underlying: number, strike: number): number {
  return Math.max(0, type === "CALL" ? underlying - strike : strike - underlying);
}

/** 표준정규 누적분포(Abramowitz–Stegun 26.2.17, 오차 < 7.5e-8) */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * 블랙-숄즈 이론가(무위험이자율 0, 정수 단위, 실수 결과).
 * @param days 만기까지 남은 일수, dailyVol 하루 변동성
 */
export function optionTheoretical(input: {
  type: OptionType;
  underlying: number;
  strike: number;
  days: number;
  dailyVol: number;
}): number {
  const { type, underlying: s, strike: k, days, dailyVol } = input;
  if (!(s > 0) || !(k > 0)) return 0;
  const sigmaT = dailyVol * Math.sqrt(Math.max(0, days));
  if (sigmaT < 1e-9) return optionIntrinsic(type, s, k);
  const d1 = (Math.log(s / k) + (sigmaT * sigmaT) / 2) / sigmaT;
  const d2 = d1 - sigmaT;
  return type === "CALL" ? s * normCdf(d1) - k * normCdf(d2) : k * normCdf(-d2) - s * normCdf(-d1);
}

/** 이론가를 호가 단위로 반올림(최소 1호가) */
export function roundPremium(def: Pick<OptionDef, "tickUnits">, value: number): number {
  return Math.max(def.tickUnits, Math.round(value / def.tickUnits) * def.tickUnits);
}

/** 쓰기 포지션의 계약당 증거금(원) = ceil(행사가 × 승수 × bps / 10000) */
export function optionWriterMarginPerContract(def: Pick<OptionDef, "family" | "unitValue">, strike: number): bigint {
  const numerator = BigInt(strike) * BigInt(def.unitValue) * BigInt(def.family.writerMarginBps);
  return (numerator + 9_999n) / 10_000n;
}

/** 쓰기 포지션 증거금(원) — 매수(양수) 포지션은 0 */
export function optionPositionMargin(def: Pick<OptionDef, "family" | "unitValue">, qty: number, strike: number): bigint {
  return qty < 0 ? optionWriterMarginPerContract(def, strike) * BigInt(-qty) : 0n;
}
