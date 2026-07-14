import { NotFoundException } from "@nestjs/common";
import { describe, expect, test } from "vitest";
import { FIXED_REPLAY_CANDLE_COUNT, FIXED_REPLAY_DATA_FIXED_AT } from "../fixed-replay-data";
import { REPLAY_RANGE_CANDLE_COUNTS } from "../replay-range";
import { ReplayService } from "../replay.service";
import type { ReplayRange } from "../replay.types";

describe("ReplayService", () => {
  test("lists an expanded, isolated replay catalog with one fixed three-year horizon", () => {
    const catalog = new ReplayService().datasets();

    expect(catalog.map((dataset) => dataset.symbol)).toEqual([
      "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "JPM",
    ]);
    expect(catalog.every((dataset) => dataset.maxCandleCount === FIXED_REPLAY_CANDLE_COUNT)).toBe(true);
    expect(catalog.every((dataset) => dataset.notice.includes("고정 1,095일봉"))).toBe(true);
  });

  test("returns the exact requested candle count for every supported period", () => {
    const service = new ReplayService();

    for (const [range, candleCount] of Object.entries(REPLAY_RANGE_CANDLE_COUNTS) as [ReplayRange, number][]) {
      const response = service.candles("aapl-us", range);
      expect(response.candles).toHaveLength(candleCount);
      expect(response.candles.every((candle) => candle.low <= candle.open && candle.high >= candle.close)).toBe(true);
      expect(response.candles.every((candle, index, candles) => index === 0 || candle.ts > candles[index - 1]!.ts)).toBe(true);
    }
  });

  test("serves the same fixed data regardless of process time or API-key configuration", () => {
    const service = new ReplayService();
    const first = service.candles("nvda-us", "3y");
    const second = service.candles("nvda-us", "3y");

    expect(first.candles).toEqual(second.candles);
    expect(first.candles).not.toBe(second.candles);
    expect(first.source).toEqual({
      provider: "bundled-fixed-daily",
      label: "내장 고정 일봉 연습 데이터",
      sourceUrl: null,
      termsUrl: null,
      fixedAt: FIXED_REPLAY_DATA_FIXED_AT,
      notice: expect.stringContaining("1,095개 고정 일봉"),
    });
  });

  test("rejects an unknown replay dataset instead of crossing into the exchange catalog", () => {
    expect(() => new ReplayService().candles("kabu", "1mo")).toThrow(NotFoundException);
  });
});
