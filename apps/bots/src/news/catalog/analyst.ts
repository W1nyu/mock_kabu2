import type { NewsTemplate } from "../types";

/**
 * 애널리스트 — 목표주가·투자의견.
 * An opinion moves the tape fast and fades fast, so every template here runs a
 * low persistence band rather than letting the model sample a long one.
 */
const OPINION_PERSISTENCE = { min: 0.905, max: 0.935 };

export const ANALYST_TEMPLATES: readonly NewsTemplate[] = [
  {
    id: "an.target.up.small",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.2, max: 0.32 },
    headlines: ["{broker}, {name} 목표주가 {target}으로 상향"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 1.05, max: 1.12 } },
    },
  },
  {
    id: "an.target.up.big",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.38, max: 0.58 },
    headlines: ["{broker}, {name} 목표주가 {pct} 대폭 상향… {target} 제시"],
    body: ['"실적 추정치 상향을 반영했다"고 밝혔다.'],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 1.18, max: 1.4 } },
      pct: { kind: "percent", range: { min: 18, max: 40 }, decimals: 0 },
    },
  },
  {
    id: "an.target.down.small",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.2, max: 0.32 },
    headlines: ["{broker}, {name} 목표주가 {target}으로 하향"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 0.88, max: 0.95 } },
    },
  },
  {
    id: "an.target.down.big",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.38, max: 0.58 },
    headlines: ["{broker}, {name} 목표주가 {pct} 대폭 하향… {target}으로 낮춰"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 0.62, max: 0.82 } },
      pct: { kind: "percent", range: { min: 18, max: 38 }, decimals: 0 },
    },
  },
  {
    id: "an.upgrade",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.35, max: 0.52 },
    headlines: ["{broker}, {name} 투자의견 '매수'로 상향… 목표주가 {target}"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 1.15, max: 1.3 } },
    },
  },
  {
    id: "an.downgrade",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.42, max: 0.62 },
    headlines: ["{broker}, {name} 투자의견 '중립'으로 하향… 목표주가 {target}"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 0.72, max: 0.88 } },
    },
  },
  {
    id: "an.toppick",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.3, max: 0.46 },
    headlines: ['{broker}, {name}{를} 업종 톱픽으로 제시… "밸류에이션 매력"'],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 1.12, max: 1.25 } },
    },
    body: ["목표주가는 {target}을 제시했다."],
  },
  {
    id: "an.initiate",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.2, max: 0.3 },
    headlines: ["{broker}, {name} 커버리지 개시… 목표주가 {target}"],
    persistence: OPINION_PERSISTENCE,
    slots: {
      broker: { kind: "pick", vocab: "broker" },
      target: { kind: "targetPrice", ratio: { min: 1.08, max: 1.2 } },
    },
  },

  {
    id: "an.coverage.drop",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.25, max: 0.42 },
    headlines: ["{broker}, {name} 커버리지 중단… '가시성 낮다'", "{broker}, {name} 투자의견 '중립'으로 낮춰… 목표주가 미제시"],
    slots: { broker: { kind: "pick", vocab: "broker" } },
  },
  {
    id: "an.consensus.up",
    category: "ANALYST",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.28, max: 0.45 },
    headlines: ["{name} 목표주가 컨센서스 {duration} 연속 상향… 평균 {targetPrice}"],
    slots: {
      duration: { kind: "duration", range: { min: 3, max: 8 }, unit: "개월" },
      targetPrice: { kind: "targetPrice", ratio: { min: 1.15, max: 1.4 } },
    },
  },
];
