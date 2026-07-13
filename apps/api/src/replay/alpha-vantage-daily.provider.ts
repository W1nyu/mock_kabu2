import { ReplayProviderError } from "./replay-provider.error";
import { selectReplayRange } from "./replay-range";
import type { ReplayCandle, ReplayDataset, ReplayHistoricalSourceResult, ReplayRange } from "./replay.types";

const ALPHA_VANTAGE_ORIGIN = "https://www.alphavantage.co";
const REQUEST_TIMEOUT_MS = 8_000;

export const ALPHA_VANTAGE_DOCUMENTATION_URL = "https://www.alphavantage.co/documentation/";
export const ALPHA_VANTAGE_TERMS_URL = "https://www.alphavantage.co/terms_of_service/";

export interface ReplayFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ReplayFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<ReplayFetchResponse>;

type AlphaOutputSize = "compact" | "full";

type ParsedAlphaDaily = {
  candles: ReplayCandle[];
  reportedOutputSize?: AlphaOutputSize;
};

/**
 * API-key-gated historical adapter. It is never asked to contact Alpha Vantage
 * until a non-empty `ALPHA_VANTAGE_API_KEY` is explicitly configured.
 */
export class AlphaVantageDailyProvider {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly request: ReplayFetch = nativeFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey?.trim());
  }

  async daily(dataset: ReplayDataset, range: ReplayRange): Promise<ReplayHistoricalSourceResult> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new ReplayProviderError(
        "온라인 실제 데이터를 사용하려면 ALPHA_VANTAGE_API_KEY를 설정해야 합니다. 키가 없을 때는 외부 요청을 보내지 않습니다.",
        { allowFixtureFallback: true },
      );
    }

    const outputSize = alphaVantageOutputSize(range);
    const requestUrl = alphaVantageRequestUrl(dataset.symbol, outputSize, apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.request(requestUrl, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new ReplayProviderError(`Alpha Vantage 일봉 요청이 실패했습니다 (${response.status}).`, {
          allowFixtureFallback: true,
        });
      }

      const parsed = parseAlphaVantageDaily(await response.json());
      if (outputSize === "full" && parsed.reportedOutputSize !== "full") {
        throw new ReplayProviderError(
          "선택한 기간에는 Alpha Vantage의 full 일봉 이력이 필요하지만, 현재 API 키가 full 응답을 제공하지 않았습니다. 제공자 권한을 확인하거나 권한이 있는 로컬 CSV를 사용하세요.",
          { allowFixtureFallback: true },
        );
      }

      const candles = selectReplayRange(parsed.candles, range);
      if (candles.length === 0) {
        throw new ReplayProviderError("선택한 기간에 사용할 수 있는 Alpha Vantage 일봉이 없습니다.", {
          allowFixtureFallback: true,
        });
      }

      return {
        provider: "alpha-vantage-daily",
        label: "Alpha Vantage historical daily chart",
        // The URL intentionally omits the API key before it is returned to a browser.
        sourceUrl: alphaVantagePublicUrl(dataset.symbol, outputSize),
        termsUrl: ALPHA_VANTAGE_TERMS_URL,
        notice:
          "사용자가 권한을 가진 Alpha Vantage API 키로 가져온 과거 일봉입니다. API 키와 데이터 권한은 브라우저에 전달하거나 재배포하지 마세요.",
        currency: dataset.currency,
        candles,
      };
    } catch (error) {
      if (error instanceof ReplayProviderError) throw error;
      throw new ReplayProviderError("Alpha Vantage 일봉 요청을 완료하지 못했습니다.", {
        cause: error,
        allowFixtureFallback: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** `compact` is enough for the short windows; longer windows require `full`. */
export function alphaVantageOutputSize(range: ReplayRange): AlphaOutputSize {
  return range === "1mo" || range === "3mo" ? "compact" : "full";
}

/** Public, non-secret request shape shown in replay metadata. */
export function alphaVantagePublicUrl(symbol: string, outputSize: AlphaOutputSize): string {
  const url = new URL("/query", ALPHA_VANTAGE_ORIGIN);
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("outputsize", outputSize);
  url.searchParams.set("datatype", "json");
  return url.toString();
}

/** Parse Alpha Vantage's JSON shape into the replay's integer-cent transport. */
export function parseAlphaVantageDaily(payload: unknown): ParsedAlphaDaily {
  const root = asRecord(payload);
  const upstreamProblem = firstString(root?.Note, root?.Information, root?.["Error Message"]);
  if (upstreamProblem) {
    throw new ReplayProviderError(`Alpha Vantage 응답 오류: ${truncate(upstreamProblem)}`, {
      allowFixtureFallback: true,
    });
  }

  const series = asRecord(root?.["Time Series (Daily)"]);
  if (!series) {
    throw new ReplayProviderError("Alpha Vantage 응답에 일봉 시계열이 없습니다.", {
      allowFixtureFallback: true,
    });
  }

  const candles = new Map<number, ReplayCandle>();
  for (const [date, rawQuote] of Object.entries(series)) {
    const quote = asRecord(rawQuote);
    const ts = dateTimestamp(date);
    const open = toMinorUnits(quote?.["1. open"]);
    const high = toMinorUnits(quote?.["2. high"]);
    const low = toMinorUnits(quote?.["3. low"]);
    const close = toMinorUnits(quote?.["4. close"]);
    if (!ts || !open || !high || !low || !close) continue;
    if (low > Math.min(open, close) || high < Math.max(open, close)) continue;
    candles.set(ts, {
      ts,
      open,
      high,
      low,
      close,
      volume: nonNegativeInteger(quote?.["5. volume"]),
    });
  }

  const normalized = [...candles.values()].sort((a, b) => a.ts - b.ts);
  if (normalized.length === 0) {
    throw new ReplayProviderError("Alpha Vantage 응답에 유효한 일봉 OHLC가 없습니다.", {
      allowFixtureFallback: true,
    });
  }

  const meta = asRecord(root?.["Meta Data"]);
  return {
    candles: normalized,
    reportedOutputSize: parseOutputSize(meta?.["4. Output Size"]),
  };
}

function alphaVantageRequestUrl(symbol: string, outputSize: AlphaOutputSize, apiKey: string): string {
  const url = new URL(alphaVantagePublicUrl(symbol, outputSize));
  url.searchParams.set("apikey", apiKey);
  return url.toString();
}

const nativeFetch: ReplayFetch = (url, init) => globalThis.fetch(url, init);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function truncate(value: string): string {
  return value.trim().slice(0, 240);
}

function dateTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ts = Date.UTC(year, month - 1, day);
  const parsed = new Date(ts);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? ts
    : undefined;
}

function decimal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toMinorUnits(value: unknown): number | undefined {
  const numeric = decimal(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const minor = Math.round(numeric * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const numeric = decimal(value);
  if (numeric === undefined || numeric <= 0) return 0;
  return Math.min(Math.trunc(numeric), Number.MAX_SAFE_INTEGER);
}

function parseOutputSize(value: unknown): AlphaOutputSize | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("full")) return "full";
  if (normalized.includes("compact")) return "compact";
  return undefined;
}
