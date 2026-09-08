import { Body, Controller, Get, Headers, NotFoundException, Post, Query } from "@nestjs/common";
import { SYMBOLS } from "@mock-kabu/shared";
import { NewsService, type PublishNewsDto } from "./news.service";

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

/** Public read surface, unguarded like the rest of /market. */
@Controller("market/news")
export class NewsController {
  constructor(private news: NewsService) {}

  @Get()
  list(@Query("symbol") symbol?: string, @Query("limit") limit?: string) {
    if (symbol !== undefined && !ACTIVE_SYMBOLS.has(symbol)) {
      throw new NotFoundException(`없는 종목: ${symbol}`);
    }
    return this.news.list(symbol, limit ? Number(limit) : 40);
  }
}

/** Internal endpoint used only by the local bots process. */
@Controller("internal/news")
export class InternalNewsController {
  constructor(private news: NewsService) {}

  @Post("publish")
  publish(@Body() dto: PublishNewsDto, @Headers("x-liquidity-bootstrap-token") token?: string) {
    return this.news.publish(token, dto);
  }
}
