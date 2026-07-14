/**
 * Replay prices are always integer units at each dataset's `priceScale`
 * (for example USD cents or whole KRW). Keeping the transport integer-based
 * also makes a later virtual order-book adapter independent from JavaScript
 * floating-point rounding.
 */
export interface ReplayCandle {
  /** UTC epoch milliseconds. Source candles are daily bars. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Replay windows are expressed as exact daily-candle counts. The lab has a
 * deliberately fixed maximum of three calendar years (1,095 candles), so a
 * selected window always has the same length for every replay ticker.
 */
export const REPLAY_RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "3y"] as const;
export type ReplayRange = (typeof REPLAY_RANGES)[number];

/** Groups are intentionally presentation-neutral so clients can make optgroups or tabs. */
export const REPLAY_DATASET_CATEGORIES = ["overseas", "domestic", "crypto"] as const;
export type ReplayDatasetCategory = (typeof REPLAY_DATASET_CATEGORIES)[number];

export interface ReplayDataset {
  id: string;
  symbol: string;
  name: string;
  category: ReplayDatasetCategory;
  exchange: string;
  currency: string;
  priceScale: number;
}

export interface ReplaySourceMeta {
  /** The replay runtime always serves this bundled, deterministic data source. */
  provider: string;
  label: string;
  sourceUrl: string | null;
  termsUrl: string | null;
  /** Fixed-data release timestamp, not an external request time. */
  fixedAt: string;
  notice: string;
}

export interface ReplayCandlesResponse {
  dataset: ReplayDataset;
  interval: "1d";
  /** The selected range, expressed as an exact replay-bar count. */
  range: ReplayRange;
  /**
   * Candles are chronological: fixed pre-roll history first, then the future
   * replay path. Clients must initialize the replay engine at this index so
   * the latter portion is not visible before playback starts.
   */
  candles: ReplayCandle[];
  preRollCandleCount: number;
  replayCandleCount: number;
  totalCandleCount: number;
  source: ReplaySourceMeta;
  /** A future bot/order-book adapter must keep quotes inside this cap. */
  hybrid: {
    supported: true;
    defaultMaxDeviationBps: number;
    description: string;
  };
}

export interface ReplayCatalogEntry extends ReplayDataset {
  defaultRange: ReplayRange;
  /** Number of candles always disclosed before replay begins. */
  preRollCandleCount: number;
  /** Longest selectable future replay path (currently 3 years). */
  maxReplayCandleCount: number;
  /** Total source candles returned for the maximum range. */
  maxCandleCount: number;
  notice: string;
}
