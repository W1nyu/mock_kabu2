import { NotFoundException } from "@nestjs/common";
import { describe, expect, test } from "vitest";
import {
  FIXED_REPLAY_CANDLE_COUNT,
  FIXED_REPLAY_DATA_FIXED_AT,
  FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT,
  FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT,
} from "../fixed-replay-data";
import { REPLAY_RANGE_CANDLE_COUNTS } from "../replay-range";
import { ReplayService } from "../replay.service";
import type { ReplayRange } from "../replay.types";

describe("ReplayService", () => {
  test("lists categorized, isolated replay instruments with pre-roll and a fixed three-year horizon", () => {
    const catalog = new ReplayService().datasets();

    expect(catalog.map((dataset) => dataset.symbol)).toEqual([
      "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "JPM",
      "005930", "000660", "005380", "035420", "005490", "BTC/USD",
    ]);
    expect(catalog.filter((dataset) => dataset.category === "overseas")).toHaveLength(10);
    expect(catalog.filter((dataset) => dataset.category === "domestic").map((dataset) => dataset.exchange)).toEqual([
      "KOSPI", "KOSPI", "KOSPI", "KOSPI", "KOSPI",
    ]);
    expect(catalog.find((dataset) => dataset.id === "btc-usd")).toMatchObject({
      category: "crypto",
      currency: "USD",
      priceScale: 100,
    });
    expect(catalog.every((dataset) => dataset.preRollCandleCount === FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT)).toBe(true);
    expect(catalog.every((dataset) => dataset.maxReplayCandleCount === FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT)).toBe(true);
    expect(catalog.every((dataset) => dataset.maxCandleCount === FIXED_REPLAY_CANDLE_COUNT)).toBe(true);
    expect(catalog.every((dataset) => dataset.notice.includes("200개 사전 공개 일봉"))).toBe(true);
  });

  test("returns exactly 200 pre-roll candles plus the requested replay length for every period", () => {
    const service = new ReplayService();

    for (const [range, candleCount] of Object.entries(REPLAY_RANGE_CANDLE_COUNTS) as [ReplayRange, number][]) {
      const response = service.candles("aapl-us", range);
      expect(response.range).toBe(range);
      expect(response.preRollCandleCount).toBe(FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT);
      expect(response.replayCandleCount).toBe(candleCount);
      expect(response.totalCandleCount).toBe(FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT + candleCount);
      expect(response.candles).toHaveLength(FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT + candleCount);
      expect(response.candles.every((candle) => candle.low <= candle.open && candle.high >= candle.close)).toBe(true);
      expect(response.candles.every((candle, index, candles) => index === 0 || candle.ts > candles[index - 1]!.ts)).toBe(true);
    }
  });

  test("serves a complete 200 + 1,095 candle exercise at the three-year limit", () => {
    const response = new ReplayService().candles("btc-usd", "3y");

    expect(response.dataset.category).toBe("crypto");
    expect(response.preRollCandleCount).toBe(200);
    expect(response.replayCandleCount).toBe(1_095);
    expect(response.totalCandleCount).toBe(1_295);
    expect(response.candles).toHaveLength(1_295);
    expect(response.candles[199]!.ts).toBeLessThan(response.candles[200]!.ts);
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
      notice: expect.stringContaining("1,295개 고정 일봉"),
    });
  });

  test("rejects an unknown replay dataset instead of crossing into the exchange catalog", () => {
    expect(() => new ReplayService().candles("kabu", "1mo")).toThrow(NotFoundException);
  });
});
