import type { ReferenceCode } from "@mock-kabu/shared";
import type { MarketEventSentiment } from "../market-model";
import type { Range } from "./random";

export type { Range };

/**
 * SYMBOL: one company. SECTOR: one or more industries, weighted by `sectorExposure`.
 * MACRO: the whole market, split by each company's macro beta.
 */
export type NewsScope = "SYMBOL" | "SECTOR" | "MACRO";

export type NewsCategory =
  | "CAPITAL"
  | "EARNINGS"
  | "ANALYST"
  | "BUSINESS"
  | "RISK"
  | "FLOW"
  | "MACRO"
  | "SECTOR"
  | "SEQUEL";

export type SectorTag =
  | "ELECTRONICS"
  | "BROKER"
  | "TRADING"
  | "HEAVY"
  | "MATERIALS"
  | "BIO"
  | "FOOD"
  | "AIRLINE"
  | "TELECOM"
  | "GAME"
  | "SEMICONDUCTOR"
  | "CONSTRUCTION"
  | "AUTO"
  | "ENTERTAINMENT"
  | "BATTERY"
  | "ENERGY"
  | "UTILITY"
  | "REIT";

/**
 * The macro axis a market-wide story moves along. Each symbol has a signed beta on it.
 * COMMODITY is industrial raw materials (copper, nickel, iron ore, lithium, freight) as
 * distinct from crude, because a trader and a shipbuilder sit on opposite sides of it.
 */
export type MacroChannel = "RATE" | "FX" | "OIL" | "COMMODITY" | "GLOBAL";

export type VocabKey =
  | "broker"
  | "inst"
  | "agency"
  | "certifier"
  | "rating"
  | "country"
  | "counterparty"
  | "product"
  | "title"
  | "index"
  | "grade"
  | "plant"
  | "commodity"
  | "centralBank"
  | "region";

export type SlotSpec =
  /** Money that scales with the company's implied market cap. */
  | { kind: "money"; capFraction: Range; minEok?: number }
  /** Money for macro stories, which have no company to scale against. */
  | { kind: "macroMoney"; eok: Range }
  /** reference: 기사가 움직일 기초자산의 실제 등락률(%)로 채운다 — range는 기초자산 값이 없을 때만 쓴다. */
  | { kind: "percent"; range: Range; decimals?: 0 | 1; reference?: true }
  /** Derived from the symbol's live price, then snapped to its tick size. */
  | { kind: "targetPrice"; ratio: Range }
  /** An absolute index/FX/oil level. */
  /** reference: 기초자산의 지금 값과 이 기사가 만들 움직임으로 "돌파/하락" 수준을 정한다 — range는 값이 없을 때만. */
  | { kind: "level"; range: Range; unit: string; decimals?: 0 | 1; reference?: true }
  | { kind: "multiple"; range: Range; decimals?: 0 | 1 }
  | { kind: "count"; range: Range; unit: string }
  | { kind: "duration"; range: Range; unit: "일" | "거래일" | "개월" | "년" | "분기" }
  | { kind: "quarter"; offsetQuarters?: number }
  | { kind: "pick"; vocab: VocabKey };

/** How a sequel relates to the story that spawned it. */
export type SequelPolarity = "SAME" | "REVERSE" | "TEMPLATE";

export interface FollowUpOutcome {
  /** Probabilities within one followUp must sum to 1. */
  readonly probability: number;
  readonly templateId: string;
  readonly polarity: SequelPolarity;
  /** Multiplied against the parent's realized strength. Defaults to 1. */
  readonly strengthScale?: number;
}

export interface FollowUpSpec {
  /** Probability that a sequel is scheduled at all. Defaults to 1. */
  readonly chance?: number;
  readonly delayMs: Range;
  readonly outcomes: readonly FollowUpOutcome[];
}

export interface NewsTemplate {
  readonly id: string;
  readonly category: NewsCategory;
  readonly scope: NewsScope;
  readonly sentiment: MarketEventSentiment;
  /** Must sit inside the price model's accepted strength band. */
  readonly strength: Range;
  readonly headlines: readonly string[];
  readonly body?: readonly string[];
  readonly slots?: Readonly<Record<string, SlotSpec>>;
  /** Per-tick impulse retention. Left undefined so startEvent samples it. */
  readonly persistence?: Range;
  readonly volumeMultiplier?: Range;
  /** Relative selection weight. Defaults to 1. */
  readonly weight?: number;
  readonly sectors?: readonly SectorTag[];
  readonly excludeSectors?: readonly SectorTag[];
  /** Reachable only as a follow-up, never by the primary picker. */
  readonly sequelOnly?: boolean;
  readonly followUp?: FollowUpSpec;
  /** Required on MACRO scope, forbidden elsewhere. */
  readonly macroChannel?: MacroChannel;
  /**
   * Which way the channel variable moved: +1 rising, -1 falling.
   *
   * Kept separate from `sentiment` because "the won rose" is a fact while
   * "that is good news" is a per-company judgement. Multiplying this by a
   * symbol's signed beta is what lets one FX headline lift the exporters and
   * hurt the brokerage at the same time. Required on MACRO scope.
   */
  readonly macroDirection?: 1 | -1;
  /**
   * Required on SECTOR scope, forbidden elsewhere. Signed weight per sector: 1 is the
   * industry the story is about, 0.3–0.6 a knock-on, and a negative weight an industry
   * the same news hurts (cheap crude lifts airlines and squeezes refiners).
   */
  readonly sectorExposure?: Readonly<Partial<Record<SectorTag, number>>>;
  /**
   * 이 기사가 움직일 선물 기초자산(원/달러·원유·천연가스·구리)과 가중치. 방향은 macroDirection, 크기는 기사 강도.
   * "commodity"면 {commodity} 품목으로 정한다(shared COMMODITY_REFERENCE_WEIGHTS). 없으면 기초자산을 움직이지 않는다.
   * 기사 속 reference 슬롯(가격·%)도 같은 움직임으로 채워 헤드라인과 실제 가격이 맞게 한다.
   */
  readonly referenceMoves?: Readonly<Partial<Record<ReferenceCode, number>>> | "commodity";
}

/** One symbol's share of a published story's price effect. */
export interface NewsImpact {
  readonly symbol: string;
  readonly sentiment: MarketEventSentiment;
  readonly strength: number;
  readonly persistence?: number;
  readonly volumeMultiplier?: number;
}

/**
 * A rendered story.
 *
 * Sentiment and strength live only inside `impact`. Keeping them off the top
 * level makes "the UI never shows direction or magnitude" a structural
 * property of the type rather than a rule someone has to remember.
 */
export interface NewsItem {
  readonly id: string;
  readonly templateId: string;
  readonly scope: NewsScope;
  readonly category: NewsCategory;
  readonly symbol: string | null;
  /** Industry id (shared INDUSTRIES) a SECTOR story is filed under; null otherwise. */
  readonly industry: string | null;
  readonly headline: string;
  readonly body: string | null;
  readonly publishedAtMs: number;
  readonly slotValues: Readonly<Record<string, string>>;
  readonly parentItemId: string | null;
  readonly impact: readonly NewsImpact[];
  /** 기초자산 충격(로그 수익률) — 기사 속 숫자를 만든 값과 같다 */
  readonly referenceMoves?: readonly { readonly code: ReferenceCode; readonly move: number }[];
}

export interface NewsSink {
  publish(item: NewsItem): void | Promise<void>;
}
