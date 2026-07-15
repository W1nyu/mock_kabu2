import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { KEYS, SYMBOLS } from "@mock-kabu/shared";
import type Redis from "ioredis";
import { PRISMA, REDIS } from "../core/tokens";

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

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

  @Get("candles/:symbol")
  candles(
    @Param("symbol") symbol: string,
    @Query("interval") interval = "1m",
    @Query("limit") limit = "180",
  ) {
    this.assertActiveSymbol(symbol);
    return this.prisma.candle
      .findMany({
        where: { symbol, interval },
        orderBy: { ts: "desc" },
        take: Math.min(Number(limit) || 180, 1000),
      })
      .then((rows) => rows.reverse());
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

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function koreaDayStart(now = Date.now()): Date {
  const shifted = new Date(now + KST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - KST_OFFSET_MS);
}
