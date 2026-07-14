import { describe, expect, test } from "vitest";
import { REPLAY_RANGE_CANDLE_COUNTS, replayRangeCandleCount, selectReplayRange } from "../replay-range";
import type { ReplayCandle, ReplayRange } from "../replay.types";

const candles: ReplayCandle[] = Array.from({ length: 1_120 }, (_, index) => ({
  ts: index + 1,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));

describe("selectReplayRange", () => {
  test("uses exact tail counts rather than market-calendar date cutoffs", () => {
    for (const [range, expectedCount] of Object.entries(REPLAY_RANGE_CANDLE_COUNTS) as [ReplayRange, number][]) {
      const selected = selectReplayRange(candles, range);
      expect(replayRangeCandleCount(range)).toBe(expectedCount);
      expect(selected).toHaveLength(expectedCount);
      expect(selected[0]?.ts).toBe(candles.length - expectedCount + 1);
      expect(selected.at(-1)?.ts).toBe(candles.length);
    }
  });

  test("does not invent candles when an optional caller has less history", () => {
    expect(selectReplayRange(candles.slice(0, 12), "1mo")).toHaveLength(12);
  });
});
