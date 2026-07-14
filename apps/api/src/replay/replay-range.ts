import type { ReplayCandle, ReplayRange } from "./replay.types";

export const REPLAY_RANGE_CANDLE_COUNTS: Readonly<Record<ReplayRange, number>> = {
  "1mo": 30,
  "3mo": 90,
  "6mo": 180,
  "1y": 365,
  "2y": 365 * 2,
  "3y": 365 * 3,
};

/** Returns the exact number of daily bars promised by a replay window. */
export function replayRangeCandleCount(range: ReplayRange): number {
  return REPLAY_RANGE_CANDLE_COUNTS[range];
}

/**
 * Select the newest N candles rather than a calendar cutoff. Market calendars
 * have weekends and holidays, but replay periods intentionally mean 30/365
 * visible bars so every ticker has a consistent exercise length.
 */
export function selectReplayRange(candles: readonly ReplayCandle[], range: ReplayRange): ReplayCandle[] {
  return candles.slice(-replayRangeCandleCount(range));
}
