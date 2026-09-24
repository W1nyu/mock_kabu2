import type { MarketEventSentiment } from "../market-model";
import type { Range } from "./random";

export type { Range };

export type NewsScope = "SYMBOL" | "MACRO";

export type NewsCategory =
  | "CAPITAL"
  | "EARNINGS"
  | "ANALYST"
  | "BUSINESS"
  | "RISK"
  | "FLOW"
  | "MACRO"
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
  | "SEMICONDUCTOR";

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
  | { kind: "percent"; range: Range; decimals?: 0 | 1 }
  /** Derived from the symbol's live price, then snapped to its tick size. */
  | { kind: "targetPrice"; ratio: Range }
  /** An absolute index/FX/oil level. */
  | { kind: "level"; range: Range; unit: string; decimals?: 0 | 1 }
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
  readonly headline: string;
  readonly body: string | null;
  readonly publishedAtMs: number;
  readonly slotValues: Readonly<Record<string, string>>;
  readonly parentItemId: string | null;
  readonly impact: readonly NewsImpact[];
}

export interface NewsSink {
  publish(item: NewsItem): void | Promise<void>;
}
