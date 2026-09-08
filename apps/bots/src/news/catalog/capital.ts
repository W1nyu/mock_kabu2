import type { NewsTemplate } from "../types";

/** 자본·주주환원 — 증자·감자·자사주·배당·지분 변동 */
export const CAPITAL_TEMPLATES: readonly NewsTemplate[] = [
  {
    id: "cap.rights.general",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.45, max: 0.7 },
    headlines: [
      "{name}, {money} 규모 유상증자 결정… 주주배정 후 실권주 일반공모",
      "{name} 유상증자 공시… 신주 발행 규모 기존 발행주식의 {pct}",
    ],
    body: ["조달 자금은 채무상환과 운영자금에 배분될 예정이다."],
    slots: {
      money: { kind: "money", capFraction: { min: 0.08, max: 0.25 } },
      pct: { kind: "percent", range: { min: 8, max: 24 } },
    },
    followUp: {
      chance: 0.7,
      delayMs: { min: 180_000, max: 540_000 },
      outcomes: [
        { probability: 0.5, templateId: "seq.rights.priced", polarity: "SAME", strengthScale: 0.5 },
        { probability: 0.3, templateId: "seq.rights.subscribed", polarity: "REVERSE", strengthScale: 0.55 },
        { probability: 0.2, templateId: "seq.rights.withdraw", polarity: "REVERSE", strengthScale: 1 },
      ],
    },
  },
  {
    id: "cap.rights.facility",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.28, max: 0.48 },
    headlines: [
      "{name}, {money} 유상증자… 전액 {plant} 시설자금",
      "{name}, 증설 재원 마련 위해 {money} 규모 유상증자 결의",
    ],
    excludeSectors: ["BROKER"],
    slots: {
      money: { kind: "money", capFraction: { min: 0.06, max: 0.18 } },
      plant: { kind: "pick", vocab: "plant" },
    },
  },
  {
    id: "cap.bonus",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.25, max: 0.45 },
    headlines: [
      "{name}, 1주당 {count} 무상증자 결정",
      "{name} 무상증자 결의… 신주배정 기준일 {duration} 뒤",
    ],
    slots: {
      count: { kind: "count", range: { min: 1, max: 3 }, unit: "주" },
      duration: { kind: "duration", range: { min: 10, max: 30 }, unit: "일" },
    },
  },
  {
    id: "cap.reduction.free",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.72, max: 0.92 },
    headlines: [
      "{name}, {multiple}대 1 무상감자 결정… 결손 보전 목적",
      "{name} 무상감자 공시, 감자비율 {pct}… 자본잠식 해소 목적",
    ],
    body: ["감자 기준일 전후 매매거래가 정지될 수 있다."],
    persistence: { min: 0.955, max: 0.98 },
    volumeMultiplier: { min: 1.5, max: 1.9 },
    slots: {
      multiple: { kind: "multiple", range: { min: 3, max: 10 } },
      pct: { kind: "percent", range: { min: 60, max: 90 }, decimals: 0 },
    },
  },
  {
    id: "cap.reduction.paid",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.25, max: 0.42 },
    headlines: ["{name}, {money} 규모 유상감자 결정… 주주환원 강화"],
    slots: { money: { kind: "money", capFraction: { min: 0.03, max: 0.09 } } },
  },
  {
    id: "cap.buyback",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.35, max: 0.55 },
    headlines: [
      "{name}, {money} 규모 자사주 취득 신탁계약 체결",
      "{name} 이사회, {money} 자사주 매입 결의",
    ],
    body: ["취득 기간은 계약일로부터 {duration}이다."],
    slots: {
      money: { kind: "money", capFraction: { min: 0.01, max: 0.05 } },
      duration: { kind: "duration", range: { min: 3, max: 12 }, unit: "개월" },
    },
  },
  {
    id: "cap.buyback.cancel",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.48, max: 0.7 },
    headlines: [
      "{name}, 보유 자사주 전량 소각 결정… 발행주식 {pct} 감소",
      "{name}, {money} 규모 자사주 소각 결의",
    ],
    slots: {
      money: { kind: "money", capFraction: { min: 0.015, max: 0.06 } },
      pct: { kind: "percent", range: { min: 1.5, max: 6 } },
    },
  },
  {
    id: "cap.dividend.up",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.28, max: 0.48 },
    headlines: [
      "{name}, 주당 배당금 {pct} 상향… 배당성향 {pct2}로 확대",
      "{name} 중간배당 도입… 연간 배당총액 {money}",
    ],
    slots: {
      pct: { kind: "percent", range: { min: 10, max: 45 }, decimals: 0 },
      pct2: { kind: "percent", range: { min: 25, max: 45 }, decimals: 0 },
      money: { kind: "money", capFraction: { min: 0.01, max: 0.04 } },
    },
  },
  {
    id: "cap.dividend.cut",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.35, max: 0.55 },
    headlines: [
      "{name}, 올해 배당 {pct} 축소 결정",
      "{name}, 결산배당 미실시 결정… {duration} 만의 무배당",
    ],
    slots: {
      pct: { kind: "percent", range: { min: 20, max: 60 }, decimals: 0 },
      duration: { kind: "duration", range: { min: 3, max: 12 }, unit: "년" },
    },
  },
  {
    id: "cap.split",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.22, max: 0.38 },
    headlines: ["{name}, {multiple}대 1 액면분할 결정… 유통주식 수 확대"],
    slots: { multiple: { kind: "multiple", range: { min: 2, max: 10 } } },
  },
  {
    id: "cap.cb",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.38, max: 0.58 },
    headlines: [
      "{name}, {money} 규모 전환사채 발행 결정… 전환가액 {target}",
      "{name} CB {money} 발행… 잠재 물량 부담 확대",
    ],
    slots: {
      money: { kind: "money", capFraction: { min: 0.03, max: 0.1 } },
      target: { kind: "targetPrice", ratio: { min: 0.85, max: 1.05 } },
    },
  },
  {
    id: "cap.blockdeal",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "NEGATIVE",
    strength: { min: 0.42, max: 0.64 },
    headlines: [
      "{name} 최대주주, 지분 {pct} 블록딜 매각",
      "{inst}, {name} 보유지분 {pct} 시간외 대량매매로 처분",
    ],
    volumeMultiplier: { min: 1.4, max: 1.8 },
    slots: {
      pct: { kind: "percent", range: { min: 1.5, max: 8 } },
      inst: { kind: "pick", vocab: "inst" },
    },
  },
  {
    id: "cap.owner.buy",
    category: "CAPITAL",
    scope: "SYMBOL",
    sentiment: "POSITIVE",
    strength: { min: 0.32, max: 0.52 },
    headlines: [
      "{name} {title}, 장내에서 {money} 규모 자사주 매입",
      "{name} 최대주주, 책임경영 차원 지분 {pct} 추가 취득",
    ],
    slots: {
      title: { kind: "pick", vocab: "title" },
      money: { kind: "money", capFraction: { min: 0.002, max: 0.012 } },
      pct: { kind: "percent", range: { min: 0.3, max: 2.5 } },
    },
  },
];
