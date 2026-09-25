/**
 * 선물의 기초자산 중 시스템에 원래 가격이 없는 것(환율·원자재)을 가상 지수로 만든다.
 * 봇이 1초마다 값을 만들어 API로 보내고, API가 Redis(최신값)와 DB(1분봉)에 남긴다.
 * 선물 정산은 DB에 저장된 값만 근거로 쓴다(설계 docs/superpowers/specs/2026-09-25-futures-design.md §3).
 *
 * 값은 정수로 저장·전송한다: 실제 값 × scale. 예) 원/달러 1,400.5원 → 14005 (scale 10).
 */
export type ReferenceCode = "USDKRW" | "OIL" | "GAS" | "COPPER";

/** 뉴스 매크로 채널 — 봇 뉴스 엔진의 MacroChannel 중 기초자산에 연결되는 것 */
export type ReferenceMacroChannel = "FX" | "OIL" | "COMMODITY";

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
  /** 시장 전체 뉴스 채널별 민감도 (방향 × 강도 × 이 값) */
  macro: Readonly<Partial<Record<ReferenceMacroChannel, number>>>;
  /** 뉴스의 {commodity} 어휘가 이 단어면 해당 품목에 직접 충격을 준다 */
  commodityWords: readonly string[];
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
    macro: { FX: 1 },
    commodityWords: [],
  },
  {
    code: "OIL",
    name: "원유",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.02,
    macro: { OIL: 1 },
    commodityWords: [],
  },
  {
    code: "GAS",
    name: "천연가스",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.035,
    macro: { OIL: 0.6 },
    commodityWords: ["천연가스"],
  },
  {
    code: "COPPER",
    name: "구리",
    unit: "pt",
    scale: 100,
    decimals: 2,
    anchor: 100,
    dailyVol: 0.015,
    macro: { COMMODITY: 1 },
    commodityWords: ["구리"],
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
