/**
 * 선물의 기초자산 중 시스템에 원래 가격이 없는 것(환율·원자재)을 가상 지수로 만든다.
 * 봇이 1초마다 값을 만들어 API로 보내고, API가 Redis(최신값)와 DB(1분봉)에 남긴다.
 * 선물 정산은 DB에 저장된 값만 근거로 쓴다(설계 docs/superpowers/specs/2026-09-25-futures-design.md §3).
 *
 * 값은 정수로 저장·전송한다: 실제 값 × scale. 예) 원/달러 1,400.5원 → 14005 (scale 10).
 */
export type ReferenceCode = "USDKRW" | "OIL" | "GAS" | "COPPER" | "GOLD" | "CORN";

export interface ReferenceAssetDef {
  code: ReferenceCode;
  name: string;
  /** 화면 단위 */
  unit: "원" | "pt";
  /** 저장값 = 실제값 × scale */
  scale: number;
  /** 화면 소수 자리 */
  decimals: number;
  /** 첫 기동 값이자 평균 회귀의 기준 (실제값) */
  anchor: number;
  /** 하루 변동성(로그수익률 표준편차) 가정 */
  dailyVol: number;
}

export const REFERENCE_ASSETS: readonly ReferenceAssetDef[] = [
  {
    code: "USDKRW",
    name: "원/달러 환율",
    unit: "원",
    scale: 10,
    decimals: 1,
    anchor: 1_400,
    dailyVol: 0.005,
  },
  {
    code: "OIL",
    name: "원유",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.02,
  },
  {
    code: "GAS",
    name: "천연가스",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.035,
  },
  {
    code: "COPPER",
    name: "구리",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.015,
  },
  {
    code: "GOLD",
    name: "금",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.01,
  },
  {
    code: "CORN",
    name: "옥수수",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.018,
  },
];

const BY_CODE = new Map(REFERENCE_ASSETS.map((asset) => [asset.code, asset]));

export function referenceAsset(code: string): ReferenceAssetDef | null {
  return BY_CODE.get(code as ReferenceCode) ?? null;
}

/** 실제값 → 저장 정수 */
export function toReferenceUnits(value: number, def: ReferenceAssetDef): number {
  return Math.round(value * def.scale);
}

/** 저장 정수 → 실제값 */
export function fromReferenceUnits(units: number, def: ReferenceAssetDef): number {
  return units / def.scale;
}

/** 소켓·Redis로 오가는 최신값 */
export interface ReferenceTick {
  code: ReferenceCode;
  /** 저장 정수(실제값 × scale) */
  value: number;
  /** epoch ms */
  ts: number;
}

/**
 * 뉴스 강도 1·가중치 1인 기사가 기초자산을 움직이는 크기 = 하루 변동성 × 이 값.
 * 기사가 "급등/급락"이라 할 만큼(원/달러 약 3~14원, 유가 약 1~4%) 움직이게 2로 둔다.
 */
export const REFERENCE_NEWS_MOVE_MULTIPLE = 2;

/** 뉴스 한 건이 기초자산에 줄 로그 수익률. 기사 속 숫자(가격·%)와 실제 가격 충격이 같은 식을 쓴다. */
export function referenceNewsMove(code: ReferenceCode, weight: number, direction: 1 | -1, strength: number): number {
  const def = referenceAsset(code);
  if (!def || !(strength > 0) || weight === 0) return 0;
  return direction * weight * strength * def.dailyVol * REFERENCE_NEWS_MOVE_MULTIPLE;
}

/**
 * 원자재 기사의 {commodity} 품목 → 움직일 기초자산과 가중치. 직접 추적하는 품목은 1, 같은 계열 금속은
 * 구리에 일부, 추적하지 않는 품목(리튬 등)은 아무것도 움직이지 않는다 — "니켈 급등" 기사가 구리를 크게 흔들지 않게.
 */
export const COMMODITY_REFERENCE_WEIGHTS: Readonly<Record<string, Readonly<Partial<Record<ReferenceCode, number>>>>> = {
  구리: { COPPER: 1 },
  금: { GOLD: 1 },
  옥수수: { CORN: 1 },
  니켈: { COPPER: 0.5 },
  알루미늄: { COPPER: 0.5 },
  아연: { COPPER: 0.5 },
  철광석: { COPPER: 0.3 },
  천연가스: { GAS: 1, OIL: 0.2 },
  석탄: { GAS: 0.3 },
  리튬: {},
};
