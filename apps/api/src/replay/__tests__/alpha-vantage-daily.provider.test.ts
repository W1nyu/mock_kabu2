import { describe, expect, test, vi } from "vitest";
import {
  AlphaVantageDailyProvider,
  alphaVantageOutputSize,
  alphaVantagePublicUrl,
  parseAlphaVantageDaily,
} from "../alpha-vantage-daily.provider";
import { ReplayProviderError } from "../replay-provider.error";

const dataset = {
  id: "aapl-us",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD",
  priceScale: 100,
};

const fullPayload = {
  "Meta Data": { "4. Output Size": "Full size" },
  "Time Series (Daily)": {
    "2024-01-03": { "1. open": "10.123", "2. high": "10.9", "3. low": "9.9", "4. close": "10.5", "5. volume": "12.9" },
    "2024-01-02": { "1. open": "12.5", "2. high": "12.9", "3. low": "12.2", "4. close": "12.7", "5. volume": "55" },
  },
};

describe("AlphaVantageDailyProvider", () => {
  test("normalizes daily OHLC strings into integer cents", () => {
    expect(parseAlphaVantageDaily(fullPayload).candles).toEqual([
      { ts: Date.UTC(2024, 0, 2), open: 1_250, high: 1_290, low: 1_220, close: 1_270, volume: 55 },
      { ts: Date.UTC(2024, 0, 3), open: 1_012, high: 1_090, low: 990, close: 1_050, volume: 12 },
    ]);
  });

  test("uses compact only for short requests and requires full for long history", () => {
    expect(alphaVantageOutputSize("1mo")).toBe("compact");
    expect(alphaVantageOutputSize("3mo")).toBe("compact");
    expect(alphaVantageOutputSize("5y")).toBe("full");
    expect(alphaVantageOutputSize("10y")).toBe("full");
    expect(alphaVantageOutputSize("max")).toBe("full");
  });

  test("does not send an external request when no API key is configured", async () => {
    const request = vi.fn();
    const provider = new AlphaVantageDailyProvider(undefined, request);

    await expect(provider.daily(dataset, "1mo")).rejects.toMatchObject({ name: "ReplayProviderError" });
    expect(request).not.toHaveBeenCalled();
  });

  test("keeps an API key out of returned source metadata", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fullPayload });
    const provider = new AlphaVantageDailyProvider("secret-key", request);

    const result = await provider.daily(dataset, "5y");

    expect(request.mock.calls[0]?.[0]).toContain("apikey=secret-key");
    expect(result.sourceUrl).not.toContain("secret-key");
    expect(result.sourceUrl).toBe(alphaVantagePublicUrl("AAPL", "full"));
  });

  test("fails clearly rather than treating compact data as a 10-year response", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...fullPayload, "Meta Data": { "4. Output Size": "Compact" } }),
    });
    const provider = new AlphaVantageDailyProvider("key", request);

    await expect(provider.daily(dataset, "10y")).rejects.toBeInstanceOf(ReplayProviderError);
  });
});
