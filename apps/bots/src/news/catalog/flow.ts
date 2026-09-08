import type { NewsTemplate } from "../types";

/**
 * 수급·시장미시 — 공매도, 외국인/기관 수급, 지수 편출입.
 * Flow stories are about positioning, not valuation, so they decay quickly.
 */
const FLOW_PERSISTENCE = { min: 0.9, max: 0.935 };

export const FLOW_TEMPLATES: readonly NewsTemplate[] = [
  {
    id: "flow.squeeze",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.45, max: 0.68 },
    headlines: [
      "{name} 공매도 잔고 급감… 숏커버링 유입",
      "{name}, 대차잔고 {pct} 감소… 숏스퀴즈 조짐",
    ],
    persistence: { min: 0.9, max: 0.925 },
    volumeMultiplier: { min: 1.5, max: 1.9 },
    slots: { pct: { kind: "percent", range: { min: 15, max: 50 }, decimals: 0 } },
    followUp: {
      chance: 0.45,
      delayMs: { min: 180_000, max: 480_000 },
      outcomes: [
        { probability: 1, templateId: "seq.squeeze.fade", polarity: "REVERSE", strengthScale: 0.7 },
      ],
    },
  },
  {
    id: "flow.short.up",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.35, max: 0.55 },
    headlines: ["{name} 공매도 잔고비중 {pct}… {duration} 만의 최고"],
    persistence: FLOW_PERSISTENCE,
    slots: {
      pct: { kind: "percent", range: { min: 2, max: 9 } },
      duration: { kind: "duration", range: { min: 3, max: 18 }, unit: "개월" },
    },
  },
  {
    id: "flow.foreign.buy",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.3, max: 0.5 },
    headlines: ["외국인, {name} {duration} 연속 순매수… 누적 {money}"],
    persistence: FLOW_PERSISTENCE,
    slots: {
      duration: { kind: "duration", range: { min: 4, max: 14 }, unit: "거래일" },
      money: { kind: "money", capFraction: { min: 0.004, max: 0.03 } },
    },
  },
  {
    id: "flow.foreign.sell",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.3, max: 0.5 },
    headlines: ["외국인, {name} {duration} 연속 순매도… 누적 {money} 이탈"],
    persistence: FLOW_PERSISTENCE,
    slots: {
      duration: { kind: "duration", range: { min: 4, max: 14 }, unit: "거래일" },
      money: { kind: "money", capFraction: { min: 0.004, max: 0.03 } },
    },
  },
  {
    id: "flow.inst.buy",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.25, max: 0.45 },
    headlines: ["기관, {name} {money} 순매수… 수급 개선 신호"],
    persistence: FLOW_PERSISTENCE,
    slots: { money: { kind: "money", capFraction: { min: 0.003, max: 0.02 } } },
  },
  {
    id: "flow.index.in",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.45, max: 0.68 },
    headlines: ["{name}, {index} 신규 편입 확정… 패시브 자금 {money} 유입 전망"],
    volumeMultiplier: { min: 1.4, max: 1.8 },
    slots: {
      index: { kind: "pick", vocab: "index" },
      money: { kind: "money", capFraction: { min: 0.01, max: 0.06 } },
    },
  },
  {
    id: "flow.index.out",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.45, max: 0.68 },
    headlines: ["{name}, {index}서 제외… 패시브 매도 {money} 예상"],
    volumeMultiplier: { min: 1.4, max: 1.8 },
    slots: {
      index: { kind: "pick", vocab: "index" },
      money: { kind: "money", capFraction: { min: 0.01, max: 0.06 } },
    },
  },
  {
    id: "flow.lockup",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.32, max: 0.5 },
    headlines: ["{name} 보호예수 물량 {count} 해제… 오버행 우려"],
    slots: { count: { kind: "count", range: { min: 100_000, max: 4_000_000 }, unit: "주" } },
  },
  {
    id: "flow.program",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.2, max: 0.32 },
    headlines: ["{name}, 프로그램 매수 {money} 유입… 장중 강세"],
    persistence: { min: 0.9, max: 0.918 },
    slots: { money: { kind: "money", capFraction: { min: 0.001, max: 0.008 } } },
  },
  {
    id: "flow.credit",
    category: "FLOW",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.28, max: 0.45 },
    headlines: ["{name} 신용잔고 급증… 반대매매 경계감"],
    persistence: FLOW_PERSISTENCE,
  },
];
