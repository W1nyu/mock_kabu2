import { Controller, Get, Inject, NotFoundException, Optional, Param, Query } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  BASE_CANDLE_INTERVAL,
  candleIntervalSeconds,
  DEFAULT_CANDLE_INTERVAL,
  KEYS,
  SYMBOLS,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { koreaDayStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { PRISMA, REDIS } from "../core/tokens";

/**
 * 읽기 캐시 TTL. 대시보드 한 화면이 요약 5개·추세선 5개·지수 1개를 15초~5분마다 부르고, 종목
 * 페이지도 요약·봉을 반복 조회한다. 몇 초 재사용해도 체감은 같고 DB 부하는 접속 수와 분리된다.
 * 1분 봉·호가·최근 체결은 실시간성이 우선이라 캐시하지 않는다.
 */
const SUMMARY_TTL_MS = 2_000;
const AGGREGATE_CANDLE_TTL_MS = 5_000;
const INDEX_TTL_MS = { "1d": 15_000, "1w": 60_000, all: 120_000 } as const;

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));
const BASE_CANDLE_SECONDS = candleIntervalSeconds(BASE_CANDLE_INTERVAL) ?? 60;

@Controller("market")
export class MarketController {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  @Get("symbols")
  symbols() {
    return this.prisma.marketSymbol.findMany({
      where: { symbol: { in: [...ACTIVE_SYMBOLS] } },
      orderBy: { symbol: "asc" },
    });
  }

  /** KST 당일 체결 기준 시세 요약. 캔들 개수 제한과 무관하게 하루 전체를 집계한다. */
  @Get("summary/:symbol")
  summary(@Param("symbol") symbol: string) {
    this.assertActiveSymbol(symbol);
    return this.cache.getOrCompute(`summary:${symbol}`, SUMMARY_TTL_MS, () => this.computeSummary(symbol));
  }

  private async computeSummary(symbol: string) {
    const sessionStart = koreaDayStart();
    const [marketSymbol, [stats]] = await Promise.all([
      this.prisma.marketSymbol.findUnique({ where: { symbol } }),
      this.prisma.$queryRaw<
        {
          high: number | null;
          low: number | null;
          volume: bigint;
          turnover: bigint;
          buy_volume: bigint;
          sell_volume: bigint;
          last_trade_ts: Date | null;
        }[]
      >`
        SELECT
          MAX(price) AS high,
          MIN(price) AS low,
          COALESCE(SUM(qty), 0) AS volume,
          COALESCE(SUM(price * qty), 0) AS turnover,
          COALESCE(SUM(qty) FILTER (WHERE taker_side = 'BUY'), 0) AS buy_volume,
          COALESCE(SUM(qty) FILTER (WHERE taker_side = 'SELL'), 0) AS sell_volume,
          MAX(created_at) AS last_trade_ts
        FROM matching.trades
        WHERE symbol = ${symbol} AND created_at >= ${sessionStart}
      `,
    ]);
    if (!marketSymbol) throw new NotFoundException(`없는 종목: ${symbol}`);

    return {
      symbol,
      referencePrice: marketSymbol.initialPrice,
      lastPrice: marketSymbol.lastPrice,
      high: stats?.high ?? null,
      low: stats?.low ?? null,
      volume: Number(stats?.volume ?? 0n),
      turnover: Number(stats?.turnover ?? 0n),
      buyVolume: Number(stats?.buy_volume ?? 0n),
      sellVolume: Number(stats?.sell_volume ?? 0n),
      // 클라이언트는 이 watermark 뒤의 WebSocket tick만 스냅샷에 덧붙인다.
      lastTradeTs: stats?.last_trade_ts?.getTime() ?? null,
    };
  }

  /**
   * 모의 시장 지수 — 5종목 동일가중, 각 종목 종가/기준가(initial_price)의 평균 × 1000.
   * 1분 봉을 구간에 맞는 버킷으로 묶고, 버킷 안에 봉이 없는 종목은 직전 값을 이어 쓴다.
   * 자산 추이와 나란히 놓고 "시장을 이겼는지" 볼 때 쓴다.
   */
  @Get("index")
  marketIndex(@Query("range") range = "1d") {
    const normalized = range === "all" || range === "1w" ? range : "1d";
    return this.cache.getOrCompute(`index:${normalized}`, INDEX_TTL_MS[normalized], () =>
      this.computeMarketIndex(normalized),
    );
  }

  private async computeMarketIndex(range: "1d" | "1w" | "all") {
    const bucketSeconds = range === "all" ? 3_600 : range === "1w" ? 600 : 60;
    const rangeMs = range === "all" ? null : range === "1w" ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
    const since = rangeMs == null ? new Date(0) : new Date(Date.now() - rangeMs);
    const symbols = await this.prisma.marketSymbol.findMany({ where: { symbol: { in: [...ACTIVE_SYMBOLS] } } });
    const rows = await this.prisma.$queryRaw<{ bucket: Date; symbol: string; close: number }[]>`
      SELECT DISTINCT ON (bucket, symbol) bucket, symbol, close
      FROM (
        SELECT
          to_timestamp(floor(extract(epoch FROM ts) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
          symbol, ts, close
        FROM market.candles
        WHERE interval = ${BASE_CANDLE_INTERVAL} AND ts >= ${since}
      ) c
      ORDER BY bucket ASC, symbol ASC, ts DESC
    `;
    const initial = new Map(symbols.map((s) => [s.symbol, s.initialPrice]));
    const last = new Map<string, number>();
    const buckets = new Map<number, Map<string, number>>();
    for (const row of rows) {
      const ts = row.bucket.getTime();
      let bucket = buckets.get(ts);
      if (!bucket) {
        bucket = new Map();
        buckets.set(ts, bucket);
      }
      bucket.set(row.symbol, row.close);
    }
    const points: { ts: number; value: number }[] = [];
    for (const ts of [...buckets.keys()].sort((a, b) => a - b)) {
      const bucket = buckets.get(ts)!;
      for (const [symbol, close] of bucket) last.set(symbol, close);
      // 아직 한 번도 거래되지 않은 종목은 기준가(=1.0)로 본다.
      let sum = 0;
      let count = 0;
      for (const [symbol, base] of initial) {
        const close = last.get(symbol) ?? base;
        if (base > 0) {
          sum += close / base;
          count += 1;
        }
      }
      if (count > 0) points.push({ ts, value: Math.round((sum / count) * 1000 * 100) / 100 });
    }
    return points;
  }

  @Get("orderbook/:symbol")
  async orderbook(@Param("symbol") symbol: string) {
    this.assertActiveSymbol(symbol);
    const json = await this.redis.get(KEYS.orderbookSnapshot(symbol));
    if (!json) {
      const s = await this.prisma.marketSymbol.findUnique({ where: { symbol } });
      if (!s) throw new NotFoundException(`없는 종목: ${symbol}`);
      return { symbol, bids: [], asks: [], lastPrice: s.lastPrice, seq: 0, ts: Date.now() };
    }
    return JSON.parse(json);
  }

  /**
   * Candles for any supported timeframe.
   *
   * Only 1m rows are stored, so anything coarser is rolled up here. The bucket
   * is a floor of the epoch by the interval, which puts the 1d boundary at
   * 00:00 UTC — exactly 09:00 KST, the trading day's open.
   */
  @Get("candles/:symbol")
  async candles(
    @Param("symbol") symbol: string,
    @Query("interval") interval = DEFAULT_CANDLE_INTERVAL,
    @Query("limit") limit = "180",
  ) {
    this.assertActiveSymbol(symbol);

    const seconds = candleIntervalSeconds(interval);
    if (seconds === null) throw new NotFoundException(`지원하지 않는 봉 간격: ${interval}`);

    const take = Math.min(Math.max(1, Number(limit) || 180), 1000);
    if (seconds === BASE_CANDLE_SECONDS) {
      const rows = await this.prisma.candle.findMany({
        where: { symbol, interval: BASE_CANDLE_INTERVAL },
        orderBy: { ts: "desc" },
        take,
      });
      return rows.reverse();
    }
    // 집계 봉은 1분 봉을 매번 다시 묶는 무거운 쿼리라 몇 초 재사용한다.
    return this.cache.getOrCompute(`candles:${symbol}:${interval}:${take}`, AGGREGATE_CANDLE_TTL_MS, () =>
      this.aggregateCandles(symbol, seconds, take),
    );
  }

  private async aggregateCandles(symbol: string, seconds: number, take: number) {
    // Bounded by a window back from the newest stored candle rather than from
    // now(), so a quiet market still returns a full chart instead of nothing.
    // The slack absorbs gaps where no trade printed inside a bucket.
    const windowSeconds = seconds * take * 3;
    const rows = await this.prisma.$queryRaw<
      { ts: Date; open: number; high: number; low: number; close: number; volume: bigint }[]
    >`
      WITH latest AS (
        SELECT max("ts") AS ts
        FROM "market"."candles"
        WHERE "symbol" = ${symbol} AND "interval" = ${BASE_CANDLE_INTERVAL}
      ),
      src AS (
        SELECT c."ts", c."open", c."high", c."low", c."close", c."volume"
        FROM "market"."candles" c, latest
        WHERE c."symbol" = ${symbol}
          AND c."interval" = ${BASE_CANDLE_INTERVAL}
          AND c."ts" > latest.ts - make_interval(secs => ${windowSeconds}::double precision)
      )
      SELECT
        to_timestamp(floor(extract(epoch FROM "ts") / ${seconds}) * ${seconds})
          AT TIME ZONE 'UTC' AS "ts",
        (array_agg("open" ORDER BY "ts" ASC))[1]   AS "open",
        max("high")                                AS "high",
        min("low")                                 AS "low",
        (array_agg("close" ORDER BY "ts" DESC))[1] AS "close",
        sum("volume")::bigint                      AS "volume"
      FROM src
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${take}
    `;
    return rows.reverse();
  }

  @Get("trades/:symbol")
  trades(@Param("symbol") symbol: string, @Query("limit") limit = "50") {
    this.assertActiveSymbol(symbol);
    return this.prisma.trade.findMany({
      where: { symbol },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
    });
  }

  private assertActiveSymbol(symbol: string): void {
    if (!ACTIVE_SYMBOLS.has(symbol)) throw new NotFoundException(`없는 종목: ${symbol}`);
  }
}

