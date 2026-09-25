import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { ReferenceService, type PublishReferenceDto } from "./reference.service";

/** 공개 조회 — 시세와 같이 로그인 없이 읽는다. */
@Controller("market/reference")
export class ReferenceController {
  constructor(private reference: ReferenceService) {}

  @Get()
  overview() {
    return this.reference.overview();
  }

  @Get(":code/candles")
  candles(@Param("code") code: string, @Query("interval") interval = "1m", @Query("limit") limit = "180") {
    return this.reference.candles(code, interval, Number(limit));
  }
}

/** 봇 전용 발행. Caddy가 /internal을 외부에서 막는다. */
@Controller("internal/reference")
export class InternalReferenceController {
  constructor(private reference: ReferenceService) {}

  @Post("publish")
  publish(@Body() dto: PublishReferenceDto, @Headers("x-liquidity-bootstrap-token") token?: string) {
    return this.reference.publish(token, dto);
  }
}
