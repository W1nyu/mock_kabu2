import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { KEYS } from "@mock-kabu/shared";
import type Redis from "ioredis";
import { PRISMA, REDIS } from "../core/tokens";

@Controller("market")
export class MarketController {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
  ) {}

  @Get("symbols")
  symbols() {
    return this.prisma.marketSymbol.findMany({ orderBy: { symbol: "asc" } });
  }

  @Get("orderbook/:symbol")
  async orderbook(@Param("symbol") symbol: string) {
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
    return this.prisma.trade.findMany({
      where: { symbol },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
    });
  }
}
