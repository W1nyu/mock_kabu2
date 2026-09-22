import type { NewsTemplate } from "../types";

/** 실적 — 어닝 서프라이즈/쇼크, 가이던스, 흑·적자전환 */
export const EARNINGS_TEMPLATES: readonly NewsTemplate[] = [
  {
    id: "earn.surprise",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.55, max: 0.8 },
    headlines: [
      "{name}, {quarter} 영업이익 {money}… 시장 전망치 {pct} 상회",
      "{name} {quarter} 어닝 서프라이즈… 영업이익 전년 대비 {pct} 급증",
    ],
    body: ["주력 사업 수익성이 개선되며 전 부문이 고르게 성장했다."],
    volumeMultiplier: { min: 1.35, max: 1.8 },
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.01, max: 0.05 } },
      pct: { kind: "percent", range: { min: 15, max: 60 }, decimals: 0 },
    },
    followUp: {
      chance: 0.6,
      delayMs: { min: 120_000, max: 360_000 },
      outcomes: [
        { probability: 0.8, templateId: "seq.earn.upgrade_wave", polarity: "SAME", strengthScale: 0.5 },
        { probability: 0.2, templateId: "seq.earn.downgrade_wave", polarity: "REVERSE", strengthScale: 0.45 },
      ],
    },
  },
  {
    id: "earn.beat",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.3, max: 0.48 },
    headlines: ["{name} {quarter} 영업이익 {money}, 컨센서스 소폭 상회"],
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.01, max: 0.05 } },
    },
  },
  {
    id: "earn.shock",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.58, max: 0.82 },
    headlines: [
      "{name}, {quarter} 영업이익 {money}에 그쳐… 전망치 {pct} 하회",
      "{name} {quarter} 어닝 쇼크… 영업이익 전년 대비 {pct} 급감",
    ],
    body: ["원가 부담과 수요 둔화가 동시에 반영됐다는 분석이다."],
    volumeMultiplier: { min: 1.35, max: 1.8 },
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.002, max: 0.015 } },
      pct: { kind: "percent", range: { min: 18, max: 65 }, decimals: 0 },
    },
    followUp: {
      chance: 0.6,
      delayMs: { min: 120_000, max: 360_000 },
      outcomes: [
        { probability: 0.8, templateId: "seq.earn.downgrade_wave", polarity: "SAME", strengthScale: 0.5 },
        { probability: 0.2, templateId: "seq.earn.upgrade_wave", polarity: "REVERSE", strengthScale: 0.45 },
      ],
    },
  },
  {
    id: "earn.miss",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.28, max: 0.46 },
    headlines: ["{name} {quarter} 영업이익 {money}, 컨센서스 소폭 하회"],
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.004, max: 0.02 } },
    },
  },
  {
    id: "earn.guidance.up",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.42, max: 0.62 },
    headlines: ['{name}, 연간 매출 가이던스 {pct} 상향… "하반기 수요 개선"'],
    slots: { pct: { kind: "percent", range: { min: 5, max: 20 } } },
  },
  {
    id: "earn.guidance.down",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.45, max: 0.68 },
    headlines: ["{name}, 연간 가이던스 {pct} 하향… 수요 부진 반영"],
    slots: { pct: { kind: "percent", range: { min: 6, max: 25 } } },
  },
  {
    id: "earn.turnaround",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.5, max: 0.72 },
    headlines: ["{name}, {quarter} 흑자전환… 영업이익 {money}"],
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.005, max: 0.025 } },
    },
  },
  {
    id: "earn.deficit",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.55, max: 0.78 },
    headlines: ["{name}, {quarter} 적자전환… 영업손실 {money}"],
    slots: {
      quarter: { kind: "quarter" },
      money: { kind: "money", capFraction: { min: 0.004, max: 0.02 } },
    },
  },
  {
    id: "earn.margin",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.25, max: 0.42 },
    headlines: ["{name} {quarter} 영업이익률 {pct}… {duration} 만의 최고치"],
    slots: {
      quarter: { kind: "quarter" },
      pct: { kind: "percent", range: { min: 8, max: 24 } },
      duration: { kind: "duration", range: { min: 4, max: 12 }, unit: "분기" },
    },
  },

  {
    id: "earn.preview.up",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.3, max: 0.5 },
    headlines: ["{broker} '{name} {quarter} 영업이익 컨센서스 {pct} 상회 전망'", "{name} {quarter} 실적 프리뷰… '어닝 서프라이즈 가능성'"],
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      quarter: { kind: "quarter" },
      pct: { kind: "percent", range: { min: 8, max: 25 }, decimals: 0 },
    },
  },
  {
    id: "earn.preview.down",
    category: "EARNINGS",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.3, max: 0.5 },
    headlines: ["{broker} '{name} {quarter} 실적 부진 예상… 영업이익 {pct} 감소 전망'", "{name} {quarter} 실적 눈높이 잇단 하향"],
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      quarter: { kind: "quarter" },
      pct: { kind: "percent", range: { min: 10, max: 35 }, decimals: 0 },
    },
  },
];
