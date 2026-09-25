import { Controller, Get, Inject, NotFoundException, Optional, Param, Query } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@mock-kabu/db";
import {
  BASE_CANDLE_INTERVAL,
  candleIntervalSeconds,
  DEFAULT_CANDLE_INTERVAL,
  epochAt,
  indexLevel,
  KEYS,
  ROLLUP_CANDLE_INTERVAL,
  ROLLUP_CANDLE_SECONDS,
  SYMBOLS,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { koreaSessionStart } from "../common/market-time";
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
const INDEX_META_TTL_MS = 10_000;
/** 재상장 전 체결은 시세에서 뺀다 (listed_at이 없으면 전체). */
const LISTED_SINCE = Prisma.sql`COALESCE(s.listed_at, '-infinity'::timestamp)`;

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));
const BASE_CANDLE_SECONDS = candleIntervalSeconds(BASE_CANDLE_INTERVAL) ?? 60;
/**
 * 1시간 이상으로 묶는 조회는 보존 기간이 지나 1시간 봉으로 합쳐진 행도 함께 읽는다.
 * 1시간 봉은 시 경계에 맞춰져 있어 1h·4h·1d 버킷 안에 정확히 들어간다.
 */
const candleSourceIntervals = (bucketSeconds: number) =>
  bucketSeconds >= ROLLUP_CANDLE_SECONDS && bucketSeconds % ROLLUP_CANDLE_SECONDS === 0
    ? Prisma.sql`IN (${BASE_CANDLE_INTERVAL}, ${ROLLUP_CANDLE_INTERVAL})`
    : Prisma.sql`= ${BASE_CANDLE_INTERVAL}`;

@Controller("market")
export class MarketController {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  @Get("symbols")
  symbols() {
    return this.symbolsForSession(koreaSessionStart());
  }

  private symbolsForSession(sessionStart: Date) {
    const nextSessionStart = new Date(sessionStart.getTime() + 24 * 60 * 60 * 1000);
    return this.cache.getOrCompute(`symbols:${sessionStart.getTime()}`, SUMMARY_TTL_MS, () =>
      this.prisma.$queryRaw<
        { symbol: string; name: string; initialPrice: number; tickSize: number; lastPrice: number; referencePrice: number }[]
      >`
        SELECT s.symbol, s.name, s.initial_price AS "initialPrice", s.tick_size AS "tickSize",
               s.last_price AS "lastPrice", COALESCE(opening.price, previous.price, s.initial_price) AS "referencePrice"
        FROM market.symbols s
        LEFT JOIN LATERAL (
          SELECT t.price FROM matching.trades t
          WHERE t.symbol = s.symbol AND t.created_at >= ${sessionStart} AND t.created_at < ${nextSessionStart}
            AND t.created_at >= ${LISTED_SINCE}
          ORDER BY t.created_at ASC, t.id ASC LIMIT 1
        ) opening ON true
        LEFT JOIN LATERAL (
          SELECT t.price FROM matching.trades t
          WHERE t.symbol = s.symbol AND t.created_at < ${sessionStart}
            AND t.created_at >= ${LISTED_SINCE}
          ORDER BY t.created_at DESC, t.id DESC LIMIT 1
        ) previous ON true
        WHERE s.symbol IN (${Prisma.join([...ACTIVE_SYMBOLS])})
        ORDER BY s.symbol ASC
      `.then((rows) => rows.map((row) => ({ ...row, sessionStart: sessionStart.getTime() }))),
    );
  }

  /**
   * 전 종목 시세 + 09:00 KST 시작 세션 요약을 한 번에. 대시보드가 `/symbols` + 종목별 `/summary` 6번을 부르던 것을
   * 요청 1번·쿼리 1번(GROUP BY symbol)으로 줄인다. 2초 캐시.
   */
  @Get("overview")
  overview() {
    const sessionStart = koreaSessionStart();
    return this.cache.getOrCompute(`overview:${sessionStart.getTime()}`, SUMMARY_TTL_MS, () => this.computeOverview(sessionStart));
  }

  private async computeOverview(sessionStart: Date) {
    const [symbols, stats] = await Promise.all([
      this.symbolsForSession(sessionStart),
      this.prisma.$queryRaw<
        {
          symbol: string;
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
          t.symbol,
          MAX(t.price) AS high,
          MIN(t.price) AS low,
          COALESCE(SUM(t.qty), 0) AS volume,
          COALESCE(SUM(t.price::bigint * t.qty), 0) AS turnover,
          COALESCE(SUM(t.qty) FILTER (WHERE t.taker_side = 'BUY'), 0) AS buy_volume,
          COALESCE(SUM(t.qty) FILTER (WHERE t.taker_side = 'SELL'), 0) AS sell_volume,
          MAX(t.created_at) AS last_trade_ts
        FROM matching.trades t
        JOIN market.symbols s ON s.symbol = t.symbol
        WHERE t.created_at >= ${sessionStart} AND t.created_at >= ${LISTED_SINCE}
        GROUP BY t.symbol
      `,
    ]);
    const bySymbol = new Map(stats.map((row) => [row.symbol, row]));
    return symbols.map((marketSymbol) => {
      const row = bySymbol.get(marketSymbol.symbol);
      return {
        symbol: marketSymbol.symbol,
        name: marketSymbol.name,
        tickSize: marketSymbol.tickSize,
        initialPrice: marketSymbol.initialPrice,
        referencePrice: marketSymbol.referencePrice,
        sessionStart: sessionStart.getTime(),
        lastPrice: marketSymbol.lastPrice,
        high: row?.high ?? null,
        low: row?.low ?? null,
        volume: Number(row?.volume ?? 0n),
        turnover: Number(row?.turnover ?? 0n),
        buyVolume: Number(row?.buy_volume ?? 0n),
        sellVolume: Number(row?.sell_volume ?? 0n),
        lastTradeTs: row?.last_trade_ts?.getTime() ?? null,
      };
    });
  }

  /** 09:00 KST부터의 체결 기준 시세 요약. 캔들 개수 제한과 무관하게 세션 전체를 집계한다. */
  @Get("summary/:symbol")
  summary(@Param("symbol") symbol: string) {
    this.assertActiveSymbol(symbol);
    const sessionStart = koreaSessionStart();
    return this.cache.getOrCompute(`summary:${symbol}:${sessionStart.getTime()}`, SUMMARY_TTL_MS, () =>
      this.computeSummary(symbol, sessionStart),
    );
  }

  private async computeSummary(symbol: string, sessionStart: Date) {
    const [symbols, [stats]] = await Promise.all([
      this.symbolsForSession(sessionStart),
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
          MAX(t.price) AS high,
          MIN(t.price) AS low,
          COALESCE(SUM(t.qty), 0) AS volume,
          COALESCE(SUM(t.price::bigint * t.qty), 0) AS turnover,
          COALESCE(SUM(t.qty) FILTER (WHERE t.taker_side = 'BUY'), 0) AS buy_volume,
          COALESCE(SUM(t.qty) FILTER (WHERE t.taker_side = 'SELL'), 0) AS sell_volume,
          MAX(t.created_at) AS last_trade_ts
        FROM matching.trades t
        JOIN market.symbols s ON s.symbol = t.symbol
        WHERE t.symbol = ${symbol} AND t.created_at >= ${sessionStart} AND t.created_at >= ${LISTED_SINCE}
      `,
    ]);
    const marketSymbol = symbols.find((row) => row.symbol === symbol);
    if (!marketSymbol) throw new NotFoundException(`없는 종목: ${symbol}`);

    return {
      symbol,
      referencePrice: marketSymbol.referencePrice,
      sessionStart: sessionStart.getTime(),
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
   * 모의 시장 지수 — 시가총액 가중: Σ(종가 × 발행주식수) ÷ 제수. 제수와 편입 종목은
   * market.index_epochs 구간이 정한다(상장 시 1,000, 재상장 등 편입 변경 시 수준이 이어지게 조정).
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

  /** 현재 지수 구간 — 웹이 실시간 체결가로 현재 지수를 같은 식으로 계산할 때 쓴다. */
  @Get("index/meta")
  indexMeta() {
    return this.cache.getOrCompute("index:meta", INDEX_META_TTL_MS, async () => {
      const [epoch, symbols] = await Promise.all([
        this.prisma.indexEpoch.findFirst({ orderBy: { startsAt: "desc" } }),
        this.prisma.marketSymbol.findMany({ where: { symbol: { in: [...ACTIVE_SYMBOLS] } } }),
      ]);
      if (!epoch) throw new NotFoundException("지수 구간이 없습니다");
      const shares = new Map(symbols.map((row) => [row.symbol, Number(row.listedShares)]));
      return {
        startsAt: epoch.startsAt.getTime(),
        divisor: epoch.divisor,
        members: epoch.members.map((symbol) => ({ symbol, listedShares: shares.get(symbol) ?? 0 })),
      };
    });
  }

  private async computeMarketIndex(range: "1d" | "1w" | "all") {
    const bucketSeconds = range === "all" ? 3_600 : range === "1w" ? 600 : 60;
    const rangeMs = range === "all" ? null : range === "1w" ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
    const since = rangeMs == null ? new Date(0) : new Date(Date.now() - rangeMs);
    const [symbols, epochRows] = await Promise.all([
      this.prisma.marketSymbol.findMany({ where: { symbol: { in: [...ACTIVE_SYMBOLS] } } }),
      this.prisma.indexEpoch.findMany({ orderBy: { startsAt: "asc" } }),
    ]);
    const epochs = epochRows.map((row) => ({ startsAt: row.startsAt.getTime(), divisor: row.divisor, members: row.members }));
    const shares = new Map(symbols.map((s) => [s.symbol, Number(s.listedShares)]));
    const prior = range === "all" ? [] : await this.prisma.$queryRaw<{ symbol: string; close: number | null }[]>`
      SELECT s.symbol, (
        SELECT c.close FROM market.candles c
        WHERE c.symbol = s.symbol AND c.interval IN (${BASE_CANDLE_INTERVAL}, ${ROLLUP_CANDLE_INTERVAL}) AND c.ts < ${since}
        ORDER BY c.ts DESC LIMIT 1
      ) AS close
      FROM market.symbols s WHERE s.symbol IN (${Prisma.join([...ACTIVE_SYMBOLS])})
    `;
    const rows = await this.prisma.$queryRaw<{ bucket: Date; symbol: string; open: number; close: number }[]>`
      SELECT DISTINCT ON (bucket, symbol) bucket, symbol,
        FIRST_VALUE(open) OVER (PARTITION BY bucket, symbol ORDER BY ts ASC) AS open,
        close
      FROM (
        SELECT
          to_timestamp(floor(extract(epoch FROM ts) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
            symbol, ts, open, close
        FROM market.candles
        WHERE interval ${candleSourceIntervals(bucketSeconds)} AND ts >= ${since}
      ) c
      ORDER BY bucket ASC, symbol ASC, ts DESC
    `;
    const initial = new Map(symbols.map((s) => [s.symbol, s.initialPrice]));
      const last = new Map<string, number>(prior.filter((row) => row.close != null).map((row) => [row.symbol, row.close!]));
      const buckets = new Map<number, Map<string, { open: number; close: number }>>();
    for (const row of rows) {
      const ts = row.bucket.getTime();
      let bucket = buckets.get(ts);
      if (!bucket) {
        bucket = new Map();
        buckets.set(ts, bucket);
      }
        bucket.set(row.symbol, { open: row.open, close: row.close });
    }
    const points: { ts: number; value: number }[] = [];
    for (const ts of [...buckets.keys()].sort((a, b) => a - b)) {
      const bucket = buckets.get(ts)!;
        for (const [symbol, candle] of bucket) last.set(symbol, candle.close);
      const epoch = epochAt(epochs, ts);
      if (!epoch || epoch.divisor <= 0) continue;
      // 09:00 점은 해당 1분봉의 시가다. 나머지 시간은 종가로 이어지며 09:00에 체결이 없는 종목은
      // 직전 가격을, 아직 한 번도 거래되지 않은(재상장 직후 포함) 종목은 상장가를 쓴다.
      const priceOf = (symbol: string) => {
        const base = initial.get(symbol) ?? 0;
        return ts % 86_400_000 === 0 ? (bucket.get(symbol)?.open ?? last.get(symbol) ?? base) : (last.get(symbol) ?? base);
      };
      const value = indexLevel(epoch, priceOf, (symbol) => shares.get(symbol) ?? 0);
      points.push({ ts, value: Math.round(value * 100) / 100 });
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
          AND c."interval" ${candleSourceIntervals(seconds)}
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
  async trades(@Param("symbol") symbol: string, @Query("limit") limit = "50") {
    this.assertActiveSymbol(symbol);
    const listed = await this.prisma.marketSymbol.findUnique({ where: { symbol }, select: { listedAt: true } });
    return this.prisma.trade.findMany({
      where: { symbol, ...(listed?.listedAt ? { createdAt: { gte: listed.listedAt } } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
    });
  }

  private assertActiveSymbol(symbol: string): void {
    if (!ACTIVE_SYMBOLS.has(symbol)) throw new NotFoundException(`없는 종목: ${symbol}`);
  }
}
