import { Controller, Get, UseGuards } from "@nestjs/common";
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
}
