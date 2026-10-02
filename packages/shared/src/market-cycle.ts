/**
 * 봇이 스스로 돌리는 장세·거시 사이클 — 관리자 화면에 보여 줄 "지금 국면" 보고 형식.
 *
 * 국면이 언제 바뀔지는 봇만 안다(비밀 토큰에서 만든 시드로 정해진다). 이 보고에는 지금
 * 국면과 시작 시각만 담고 끝나는 시각은 담지 않는다 — 관리자 화면에서도 다음 장세를 미리
 * 알 수 없게.
 */
export type MarketCyclePhase = "BULL" | "BEAR" | "SIDEWAYS";

/** 거시 변수의 흐름: 오르는 중(금리 인상기·환율 상승기…), 내리는 중, 머무는 중 */
export type MacroCyclePhase = "RISING" | "FALLING" | "STEADY";

/** 사이클이 도는 거시 변수 — 뉴스의 시장 채널 중 GLOBAL(위험 선호)은 장세 자체라 빠진다 */
export type MacroCycleDriver = "RATE" | "FX" | "OIL" | "COMMODITY";

export const MACRO_CYCLE_DRIVERS: readonly MacroCycleDriver[] = ["RATE", "FX", "OIL", "COMMODITY"];

export interface MarketCycleReport {
  /** 봇이 이 보고를 만든 시각 */
  reportedAtMs: number;
  market: {
    phase: MarketCyclePhase;
    sinceMs: number;
    /** 사이클만의 기울기(−1 하락 ~ +1 상승) */
    cycleLean: number;
    /** 사이클 + 지수 수준(밸류에이션) 보정 — 실제로 뉴스·주문 흐름에 쓰는 값 */
    lean: number;
    /** 평균적인 종목의 기사 중 호재 비율(0~1) */
    positiveShare: number;
  };
  drivers: Record<MacroCycleDriver, { phase: MacroCyclePhase; sinceMs: number; lean: number }>;
  valuation: {
    /** 봇 기준가로 계산한 지금 시장 지수(아직 모르면 null) */
    index: number | null;
    /** 장기 적정 지수 */
    fairIndex: number;
    /** 지수가 적정 수준에서 벗어난 만큼 반대로 당기는 기울기 */
    pull: number;
  };
}
