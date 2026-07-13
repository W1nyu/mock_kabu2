import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, test, vi } from "vitest";
import { ReplayProviderError } from "../replay-provider.error";
import { ReplayService } from "../replay.service";

const alphaResult = {
  provider: "alpha-vantage-daily",
  label: "Alpha Vantage historical daily chart",
  sourceUrl: "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL",
  termsUrl: "https://www.alphavantage.co/terms_of_service/",
  notice: "테스트 승인 공급자 데이터",
  currency: "USD",
  candles: [{ ts: 1_700_000_000_000, open: 1_000, high: 1_100, low: 950, close: 1_050, volume: 42 }],
};

function makeService(
  daily = vi.fn().mockResolvedValue(alphaResult),
  dailyIfPresent = vi.fn().mockResolvedValue(null),
  configuration = { alpha: true, csv: false },
) {
  const alpha = { daily, isConfigured: () => configuration.alpha };
  const localCsv = { dailyIfPresent, isConfigured: () => configuration.csv };
  return { service: new ReplayService(alpha as never, localCsv as never), daily, dailyIfPresent };
}

describe("ReplayService", () => {
  test("keeps authorized historical data outside the existing market symbol catalog", async () => {
    const { service } = makeService();

    const catalog = service.datasets();
    const response = await service.candles("aapl-us", "1mo", "auto");

    expect(catalog.map((dataset) => dataset.id)).toEqual(["aapl-us", "msft-us", "nvda-us"]);
    expect(catalog[0]?.dataSourceConfiguration).toMatchObject({ alphaVantageConfigured: true, localCsvConfigured: false });
    expect(response.dataset.symbol).toBe("AAPL");
    expect(response.source).toMatchObject({ provider: "alpha-vantage-daily", isFallback: false, cacheHit: false });
    expect(response.candles[0]?.close).toBe(1_050);
    expect(response.hybrid.defaultMaxDeviationBps).toBe(500);
  });

  test("short-caches the same dataset and range without repeating an outbound source call", async () => {
    const { service, daily } = makeService();

    await service.candles("aapl-us", "6mo", "auto");
    const cached = await service.candles("aapl-us", "6mo", "auto");

    expect(daily).toHaveBeenCalledTimes(1);
    expect(cached.source.cacheHit).toBe(true);
  });

  test("forwards extended 5y, 10y, and max windows through the configured provider", async () => {
    const { service, daily } = makeService();

    await service.candles("nvda-us", "5y", "auto");
    await service.candles("nvda-us", "10y", "auto");
    await service.candles("nvda-us", "max", "auto");

    expect(daily).toHaveBeenNthCalledWith(1, expect.objectContaining({ symbol: "NVDA" }), "5y");
    expect(daily).toHaveBeenNthCalledWith(2, expect.objectContaining({ symbol: "NVDA" }), "10y");
    expect(daily).toHaveBeenNthCalledWith(3, expect.objectContaining({ symbol: "NVDA" }), "max");
  });

  test("uses no configured source when an explicit fixture is requested", async () => {
    const { service, daily, dailyIfPresent } = makeService();

    const response = await service.candles("aapl-us", "max", "fixture");

    expect(daily).not.toHaveBeenCalled();
    expect(dailyIfPresent).not.toHaveBeenCalled();
    expect(response.source).toMatchObject({ provider: "bundled-fixture", isFallback: true });
    expect(response.candles).toHaveLength(25);
    expect(response.candles.every((candle) => candle.low <= candle.open && candle.high >= candle.close)).toBe(true);
  });

  test("uses an explicit local CSV before the API-key provider and does not make an outbound call", async () => {
    const localResult = {
      ...alphaResult,
      provider: "local-csv",
      label: "사용자 제공 로컬 CSV 일봉",
      sourceUrl: "local://replay-csv/aapl-us.csv",
      termsUrl: null,
    };
    const daily = vi.fn();
    const dailyIfPresent = vi.fn().mockResolvedValue(localResult);
    const { service } = makeService(daily, dailyIfPresent, { alpha: true, csv: true });

    const response = await service.candles("aapl-us", "10y", "auto");

    expect(response.source).toMatchObject({ provider: "local-csv", termsUrl: null });
    expect(dailyIfPresent).toHaveBeenCalledTimes(1);
    expect(daily).not.toHaveBeenCalled();
  });

  test("falls back only for an explicitly eligible source failure and only where a fixture exists", async () => {
    const daily = vi.fn().mockRejectedValue(new ReplayProviderError("API key is not configured", { allowFixtureFallback: true }));
    const { service } = makeService(daily);

    await expect(service.candles("aapl-us", "1mo", "auto")).resolves.toMatchObject({
      source: { provider: "bundled-fixture", isFallback: true },
    });
    await expect(service.candles("msft-us", "1mo", "auto")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  test("does not disguise a malformed local CSV as an AAPL fixture", async () => {
    const daily = vi.fn();
    const dailyIfPresent = vi.fn().mockRejectedValue(new ReplayProviderError("CSV OHLC is invalid"));
    const { service } = makeService(daily, dailyIfPresent, { alpha: true, csv: true });

    await expect(service.candles("aapl-us", "max", "auto")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(daily).not.toHaveBeenCalled();
  });
});
