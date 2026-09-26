/**
 * 1일물 옵션 — 원자재지수(KCOM) 옵션·원/달러 옵션 (설계 docs/superpowers/specs/2026-09-26-options-design.md).
 *
 * 종목 이름은 고정(`KCOMC3` = 원자재지수 콜 3번)이고 행사가만 매일 04:11 정산 뒤 등가격 기준으로 다시 깐다.
 * 가격은 모두 기초자산과 같은 정수 단위(실제 × priceScale)다. 1계약의 원화 가치 = 가격 단위 × unitValue.
 *
 * 주가지수 옵션(K, `KC1`~`KP5`)은 2026-09-26 거래를 끝냈다(retired): 새 매수·쓰기는 받지 않고 보유분 매도와
 * 만기 정산만 한다. 같은 기초자산의 선물(KABUF)과 겹쳐 원자재 바스켓 지수로 바꿨다.
 */
export type OptionType = "CALL" | "PUT";
export type OptionFamilyCode = "K" | "U" | "KCOM";

export interface OptionFamilyDef {
  code: OptionFamilyCode;
  name: string;
  /**
   * 기초자산 = 이 선물들의 기초자산 값(같은 정수 단위)의 단순 평균. 하나면 그 값 그대로.
   * 결제가도 같은 선물들의 일일 결제가로 계산한다.
   */
  futures: readonly string[];
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
  /** 거래 종료 — 보유분 매도·만기 정산만(새 매수·쓰기 불가), 목록에 보이지 않는다 */
  retired?: boolean;
}

/** KCOM 구성 원자재 선물(동일 가중, 환율 제외). 모두 기준값 100(anchor)이라 평균이 곧 지수 수준이다. */
export const KCOM_COMPONENT_FUTURES = ["OILF", "GASF", "CPRF", "GOLDF", "CORNF"] as const;

/** 거래 중인 옵션 계열 */
export const OPTION_FAMILIES: readonly OptionFamilyDef[] = [
  {
    code: "KCOM",
    name: "원자재지수",
    futures: KCOM_COMPONENT_FUTURES,
    priceScale: 100,
    decimals: 2,
    unit: "pt",
    // 0.01pt 호가, 1pt = 10만 원. 등가격 하루 옵션 ≈ 0.4 × 1.1% × 100pt ≈ 0.44pt(4.4만 원)
    tickUnits: 1,
    unitValue: 1_000,
    strikeStepUnits: 50,
    // 5종 평균이라 개별 원자재(1~3.5%)보다 낮다. 원자재 기사가 여러 품목을 함께 움직여 독립 가정(0.95%)보다 조금 높게.
    dailyVol: 0.011,
    writerMarginBps: 400,
    reserve: "OPT_KCOM",
  },
  {
    code: "U",
    name: "원/달러",
    futures: ["USDF"],
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

/** 거래를 끝낸 옵션 계열 — 남은 포지션의 매도·만기 정산에만 쓴다. */
export const RETIRED_OPTION_FAMILIES: readonly OptionFamilyDef[] = [
  {
    code: "K",
    name: "주가지수",
    futures: ["KABUF"],
    priceScale: 100,
    decimals: 2,
    unit: "pt",
    tickUnits: 5,
    unitValue: 100,
    strikeStepUnits: 1_000,
    dailyVol: 0.012,
    writerMarginBps: 800,
    reserve: "OPT_KABU",
    retired: true,
  },
];

export const ALL_OPTION_FAMILIES: readonly OptionFamilyDef[] = [...OPTION_FAMILIES, ...RETIRED_OPTION_FAMILIES];

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

function seriesOf(family: OptionFamilyDef): OptionDef[] {
  return (["CALL", "PUT"] as const).flatMap((type) =>
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
  );
}

/** 거래 중인 옵션 종목(체인·봇·행사가 깔기) */
export const OPTIONS: readonly OptionDef[] = OPTION_FAMILIES.flatMap(seriesOf);
/** 거래를 끝낸 옵션 종목 */
export const RETIRED_OPTIONS: readonly OptionDef[] = RETIRED_OPTION_FAMILIES.flatMap(seriesOf);
/** 전부 — 체결·포지션 평가·만기 정산·정합성은 거래를 끝낸 종목도 다룬다 */
export const ALL_OPTIONS: readonly OptionDef[] = [...OPTIONS, ...RETIRED_OPTIONS];

const BY_SYMBOL = new Map(ALL_OPTIONS.map((option) => [option.symbol, option]));

export function optionDef(symbol: string): OptionDef | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

export function isOption(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

export function optionFamily(code: string): OptionFamilyDef | null {
  return ALL_OPTION_FAMILIES.find((family) => family.code === code) ?? null;
}

/**
 * 계열의 기초자산 값(정수 단위) = 구성 선물의 기초자산(또는 결제가) 평균. 하나라도 없으면 null —
 * 일부 품목만으로 계산한 값으로 행사가를 깔거나 정산하지 않는다.
 */
export function optionUnderlyingUnits(family: OptionFamilyDef, pricesByFuture: ReadonlyMap<string, number>): number | null {
  let sum = 0;
  for (const symbol of family.futures) {
    const value = pricesByFuture.get(symbol);
    if (value == null || !(value > 0)) return null;
    sum += value;
  }
  return family.futures.length > 0 ? Math.round(sum / family.futures.length) : null;
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
