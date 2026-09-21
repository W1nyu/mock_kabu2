import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
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
import { PRISMA, REDIS } from "../core/tokens";

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));
const BASE_CANDLE_SECONDS = candleIntervalSeconds(BASE_CANDLE_INTERVAL) ?? 60;

@Controller("market")
export class MarketController {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
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
  async summary(@Param("symbol") symbol: string) {
    this.assertActiveSymbol(symbol);
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

