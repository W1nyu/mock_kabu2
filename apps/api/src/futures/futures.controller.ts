import { timingSafeEqual } from "node:crypto";
import { Body, Controller, Get, Headers, Post, UnauthorizedException, UseGuards } from "@nestjs/common";
import { futuresTradingDay } from "@mock-kabu/shared";
import { liquidityBootstrapToken } from "../liquidity/liquidity-reserve";
import { FuturesSettlementService } from "./futures-settlement.service";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FuturesService } from "./futures.service";

/** 공개 시세 — 선물 5종과 기초자산 */
@Controller("market/futures")
export class FuturesController {
  constructor(private futures: FuturesService) {}

  @Get()
  overview() {
    return this.futures.overview();
  }
}

/** 내 선물 포지션·증거금 */
@Controller("account/futures")
@UseGuards(JwtAuthGuard)
export class AccountFuturesController {
  constructor(private futures: FuturesService) {}

  @Get()
  positions(@CurrentUser() user: { accountId: string }) {
    return this.futures.positions(user.accountId);
  }

  /** 종목 레버리지 설정 `{symbol, leverage: 1~20 | null}` — 포지션·미체결이 없을 때만 */
  @Post("leverage")
  setLeverage(@CurrentUser() user: { accountId: string }, @Body() body: { symbol: string; leverage: number | null }) {
    return this.futures.setLeverage(user.accountId, String(body?.symbol ?? ""), body?.leverage ?? null);
  }
}

/**
 * 운영자 수동 정산(오늘 거래일). 봇·운영 전용 토큰, Caddy가 /internal을 외부에서 막는다.
 * 정산은 멱등이라 이미 끝난 거래일에 다시 불러도 아무것도 바꾸지 않는다.
 */
@Controller("internal/futures")
export class InternalFuturesController {
  constructor(private settlement: FuturesSettlementService) {}

  @Post("settle")
  async settle(@Headers("x-liquidity-bootstrap-token") token?: string) {
    const expected = Buffer.from(liquidityBootstrapToken());
    const presented = Buffer.from(token ?? "");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new UnauthorizedException("invalid liquidity bootstrap token");
    }
    return this.settlement.settle(futuresTradingDay(Date.now()));
  }
}
