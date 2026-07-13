import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AlphaVantageDailyProvider } from "./alpha-vantage-daily.provider";
import { findReplayDataset, REPLAY_DATASETS } from "./replay.catalog";
import { fixtureFor } from "./replay.fixture";
import { LocalCsvReplayProvider } from "./local-csv.provider";
import { ReplayProviderError } from "./replay-provider.error";
import type {
  ReplayCandlesResponse,
  ReplayCatalogEntry,
  ReplayDataset,
  ReplayHistoricalSourceResult,
  ReplayRange,
  ReplaySourcePreference,
} from "./replay.types";

export const REPLAY_ALPHA_VANTAGE_PROVIDER = "REPLAY_ALPHA_VANTAGE_PROVIDER";
export const REPLAY_LOCAL_CSV_PROVIDER = "REPLAY_LOCAL_CSV_PROVIDER";
const CACHE_TTL_MS = 5 * 60 * 1_000;
// The detailed deterministic band implementation lives in @mock-kabu/shared's
// HybridReplayEngine. This only advertises the replay-page default.
const DEFAULT_HYBRID_MAX_DEVIATION_BPS = 500;

type CachedHistorical = {
  result: ReplayHistoricalSourceResult;
  fetchedAt: number;
  expiresAt: number;
};

@Injectable()
export class ReplayService {
  private readonly cache = new Map<string, CachedHistorical>();
  private readonly pending = new Map<string, Promise<CachedHistorical>>();

  constructor(
    @Inject(REPLAY_ALPHA_VANTAGE_PROVIDER) private readonly alphaVantage: AlphaVantageDailyProvider,
    @Inject(REPLAY_LOCAL_CSV_PROVIDER) private readonly localCsv: LocalCsvReplayProvider,
  ) {}

  datasets(): ReplayCatalogEntry[] {
    return REPLAY_DATASETS.map((dataset) => ({
      ...dataset,
      defaultRange: "6mo",
      availableSources: dataset.fallbackFixture ? ["auto", "fixture"] : ["auto"],
      cacheTtlSeconds: CACHE_TTL_MS / 1_000,
      notice:
        "실전 리플레이는 기존 거래소와 분리됩니다. 온라인 데이터는 사용자가 권한을 가진 공급자를 명시적으로 설정한 경우에만 요청합니다.",
      dataSourceConfiguration: {
        localCsvConfigured: this.localCsv.isConfigured(),
        alphaVantageConfigured: this.alphaVantage.isConfigured(),
        priority: ["local-csv", "alpha-vantage-daily", "bundled-fixture"],
        longHistoryNotice:
          "5y·10y·max는 권한 있는 로컬 CSV 또는 Alpha Vantage full 일봉 응답이 필요합니다. 제공자 키의 권한이 부족하면 데이터를 축소해 보여 주지 않고 오류로 알립니다.",
      },
    }));
  }

  async candles(
    datasetId: string,
    range: ReplayRange,
    preference: ReplaySourcePreference,
  ): Promise<ReplayCandlesResponse> {
    const dataset = findReplayDataset(datasetId);
    if (!dataset) throw new NotFoundException(`Unknown replay dataset: ${datasetId}`);

    if (preference === "fixture") {
      return this.fixtureResponse(dataset, "사용자가 내장 오프라인 fixture를 선택했습니다.");
    }

    try {
      const { cached, cacheHit } = await this.historicalResult(dataset, range);
      return this.historicalResponse(dataset, cached, cacheHit);
    } catch (error) {
      // Only an explicitly marked external/configuration failure can use the
      // bundled AAPL sample. A malformed local CSV must remain visible to its
      // owner instead of being silently replaced with unrelated sample data.
      if (error instanceof ReplayProviderError && error.allowFixtureFallback && dataset.fallbackFixture) {
        return this.fixtureResponse(
          dataset,
          `${error.message} AAPL 결정론적 내장 fixture로 대체했습니다.`,
        );
      }
      const reason = error instanceof ReplayProviderError ? error.message : "알 수 없는 로컬 데이터 오류";
      throw new ServiceUnavailableException(`리플레이 데이터를 불러올 수 없습니다: ${reason}`);
    }
  }

  private async historicalResult(
    dataset: ReplayDataset,
    range: ReplayRange,
  ): Promise<{ cached: CachedHistorical; cacheHit: boolean }> {
    const key = `${dataset.id}:${range}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return { cached, cacheHit: true };

    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.loadHistoricalSource(dataset, range).then((result) => {
        const fetchedAt = Date.now();
        const entry = { result, fetchedAt, expiresAt: fetchedAt + CACHE_TTL_MS };
        this.cache.set(key, entry);
        return entry;
      });
      this.pending.set(key, pending);
      // Do not use `finally()` here: its returned rejected promise would be
      // detached when a source fails and can become an unhandled rejection.
      void pending.then(
        () => this.pending.delete(key),
        () => this.pending.delete(key),
      );
    }

    return { cached: await pending, cacheHit: false };
  }

  private async loadHistoricalSource(
    dataset: ReplayDataset,
    range: ReplayRange,
  ): Promise<ReplayHistoricalSourceResult> {
    // The explicit local directory is tried first. It avoids an outbound
    // request for that dataset and lets a user replay data they are licensed
    // to possess. A missing per-symbol file intentionally falls through.
    const local = await this.localCsv.dailyIfPresent(dataset, range);
    if (local) return local;
    return this.alphaVantage.daily(dataset, range);
  }

  private historicalResponse(
    dataset: ReplayDataset,
    cached: CachedHistorical,
    cacheHit: boolean,
  ): ReplayCandlesResponse {
    const source = cached.result;
    return {
      dataset: { ...dataset, currency: source.currency },
      interval: "1d",
      candles: source.candles,
      source: {
        provider: source.provider,
        label: source.label,
        sourceUrl: source.sourceUrl,
        termsUrl: source.termsUrl,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        cacheHit,
        isFallback: false,
        notice: source.notice,
      },
      hybrid: hybridHint(),
    };
  }

  private fixtureResponse(dataset: ReplayDataset, reason: string): ReplayCandlesResponse {
    const candles = fixtureFor(dataset.id);
    if (!candles) {
      throw new ServiceUnavailableException(`No bundled replay fixture is available for ${dataset.symbol}`);
    }
    return {
      dataset,
      interval: "1d",
      candles: [...candles],
      source: {
        provider: "bundled-fixture",
        label: "내장 AAPL 과거 시세 시각화 fixture",
        sourceUrl: "https://github.com/plotly/datasets/blob/master/finance-charts-apple.csv",
        termsUrl: "https://github.com/plotly/datasets/blob/master/LICENSE",
        fetchedAt: new Date().toISOString(),
        cacheHit: false,
        isFallback: true,
        notice: `${reason} 작은 MIT 라이선스 시각화 샘플이며, 금융급 시세 피드가 아닙니다.`,
      },
      hybrid: hybridHint(),
    };
  }
}

function hybridHint(): ReplayCandlesResponse["hybrid"] {
  return {
    supported: true,
    defaultMaxDeviationBps: DEFAULT_HYBRID_MAX_DEVIATION_BPS,
    description:
      "혼합 모드의 가상 봇은 실제 기준 경로 대비 ±5% 이내에서만 가격 압력을 더합니다. 이 API는 기존 거래소의 주문·봇·잔액을 바꾸지 않습니다.",
  };
}
