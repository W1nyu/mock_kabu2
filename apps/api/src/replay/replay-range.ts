import type { ReplayCandle, ReplayRange } from "./replay.types";
import { FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT } from "./fixed-replay-data";

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

/** Number of chronological source candles needed for a selected exercise. */
export function replayWindowCandleCount(range: ReplayRange): number {
  return FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT + replayRangeCandleCount(range);
}

/**
 * Select the newest pre-roll + N candles rather than a calendar cutoff.
 * Market calendars have weekends and holidays, but replay periods intentionally
 * mean 30/365 future bars so every ticker has a consistent exercise length.
 */
export function selectReplayRange(candles: readonly ReplayCandle[], range: ReplayRange): ReplayCandle[] {
  return candles.slice(-replayWindowCandleCount(range));
}
