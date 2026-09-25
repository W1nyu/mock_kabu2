import { Body, Controller, Get, Headers, NotFoundException, Post, Query } from "@nestjs/common";
import { industryById, SYMBOLS } from "@mock-kabu/shared";
import { NewsService, type PublishNewsDto } from "./news.service";

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));
const MARKET_WIDE = "market";

/** Public read surface, unguarded like the rest of /market. */
@Controller("market/news")
export class NewsController {
  constructor(private news: NewsService) {}

  @Get()
  list(
    @Query("symbol") symbol?: string,
    @Query("limit") limit?: string,
    @Query("industry") industry?: string,
    @Query("scope") scope?: string,
  ) {
    const take = limit ? Number(limit) : 40;
    // 산업군 피드는 소속 종목 기사와 산업군 기사 — 시장 전반 기사는 `industry=market`으로 따로 본다.
    if (industry !== undefined) {
      if (industry === MARKET_WIDE) return this.news.list(undefined, take, null);
      const def = industryById(industry);
      if (!def) throw new NotFoundException(`없는 산업군: ${industry}`);
      return this.news.list(undefined, take, def);
    }
    if (symbol !== undefined && !ACTIVE_SYMBOLS.has(symbol)) {
      throw new NotFoundException(`없는 종목: ${symbol}`);
    }
    // scope=own: 종목 화면의 "이 종목" 탭 — 그 종목 기사만(시장·업종 기사 제외)
    return this.news.list(symbol, take, undefined, scope === "own" && symbol !== undefined);
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
