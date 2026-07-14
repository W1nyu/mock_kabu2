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
 * Replay windows are expressed as exact daily-candle counts. The lab has a
 * deliberately fixed maximum of three calendar years (1,095 candles), so a
 * selected window always has the same length for every replay ticker.
 */
export const REPLAY_RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "3y"] as const;
export type ReplayRange = (typeof REPLAY_RANGES)[number];

export interface ReplayDataset {
  id: string;
  symbol: string;
  name: string;
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
  maxCandleCount: number;
  notice: string;
}
