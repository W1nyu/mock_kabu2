import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalCsvReplayProvider, parseLocalReplayCsv } from "../local-csv.provider";
import { ReplayProviderError } from "../replay-provider.error";

const dataset = {
  id: "aapl-us",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD",
  priceScale: 100,
};

describe("parseLocalReplayCsv", () => {
  test("normalizes quoted CSV rows, optional volume, and chronological order", () => {
    const candles = parseLocalReplayCsv([
      "date,open,high,low,close,volume",
      "2024-01-03,10.10,10.90,9.90,10.50,12",
      "2024-01-02,12.50,12.90,12.20,12.70,\"1,200\"",
    ].join("\n"));

    expect(candles).toEqual([
      { ts: Date.UTC(2024, 0, 2), open: 1_250, high: 1_290, low: 1_220, close: 1_270, volume: 1_200 },
      { ts: Date.UTC(2024, 0, 3), open: 1_010, high: 1_090, low: 990, close: 1_050, volume: 12 },
    ]);
  });

  test("rejects missing required headers and invalid OHLC rather than silently repairing a user file", () => {
    expect(() => parseLocalReplayCsv("date,open,close\n2024-01-02,10,11")).toThrow(ReplayProviderError);
    expect(() => parseLocalReplayCsv("date,open,high,low,close\n2024-01-02,10,9,8,10")).toThrow(ReplayProviderError);
  });

  test("is inert without an explicit directory and reads only the catalog-owned CSV filename when enabled", async () => {
    const disabled = new LocalCsvReplayProvider(undefined);
    await expect(disabled.dailyIfPresent(dataset, "max")).resolves.toBeNull();

    const directory = await mkdtemp(join(tmpdir(), "mock-kabu-replay-"));
    try {
      await writeFile(
        join(directory, "aapl-us.csv"),
        [
          "date,open,high,low,close,volume",
          "2019-01-02,10,11,9,10.5,100",
          "2024-01-02,20,21,19,20.5,200",
        ].join("\n"),
        "utf8",
      );
      const provider = new LocalCsvReplayProvider(directory);

      const max = await provider.dailyIfPresent(dataset, "max");
      const recent = await provider.dailyIfPresent(dataset, "1mo");

      expect(max?.provider).toBe("local-csv");
      expect(max?.sourceUrl).toBe("local://replay-csv/aapl-us.csv");
      expect(max?.sourceUrl).not.toContain(directory);
      expect(max?.candles).toHaveLength(2);
      expect(recent?.candles).toHaveLength(1);
      expect(recent?.candles[0]?.ts).toBe(Date.UTC(2024, 0, 2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
