/**
 * Replay prices are always integer minor units (USD cents for the bundled
 * catalog). Keeping the transport integer-based also makes a later virtual
 * order-book adapter independent from JavaScript floating-point rounding.
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
 * Daily-history windows accepted by the isolated historical-data adapters.
 * `max` means the provider's available listing history, not an assurance that
 * every instrument has data for the same number of years.
 */
export const REPLAY_RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"] as const;
export type ReplayRange = (typeof REPLAY_RANGES)[number];

export type ReplaySourcePreference = "auto" | "fixture";

export interface ReplayDataset {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  priceScale: number;
  fallbackFixture?: string;
}

export interface ReplaySourceMeta {
  /** Provider names are intentionally extensible for user-authorized local data. */
  provider: string;
  label: string;
  sourceUrl: string;
  /** Null when the user is responsible for the rights of a local file. */
  termsUrl: string | null;
  fetchedAt: string;
  cacheHit: boolean;
  isFallback: boolean;
  /** Deliberately surfaced so a UI cannot present it as a licensed live feed. */
  notice: string;
}

export interface ReplayCandlesResponse {
  dataset: ReplayDataset;
  interval: "1d";
  candles: ReplayCandle[];
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
  availableSources: ReplaySourcePreference[];
  cacheTtlSeconds: number;
  notice: string;
  dataSourceConfiguration: {
    localCsvConfigured: boolean;
    alphaVantageConfigured: boolean;
    /** Local user-authorized data wins before an outbound API request. */
    priority: readonly ["local-csv", "alpha-vantage-daily", "bundled-fixture"];
    longHistoryNotice: string;
  };
}

/** Normalized, non-secret result returned by an isolated historical adapter. */
export interface ReplayHistoricalSourceResult {
  provider: string;
  label: string;
  sourceUrl: string;
  termsUrl: string | null;
  notice: string;
  currency: string;
  candles: ReplayCandle[];
}
