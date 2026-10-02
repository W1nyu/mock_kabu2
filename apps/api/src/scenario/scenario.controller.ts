import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { MarketCycleService } from "./market-cycle.service";
import { ScenarioService, type CreateScenarioDto } from "./scenario.service";

/** 관리자 전용. 관리자가 아닌 계정에는 404로 응답한다. */
@Controller("admin/market-scenarios")
@UseGuards(JwtAuthGuard)
export class AdminScenarioController {
  constructor(private scenarios: ScenarioService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.scenarios.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() body: CreateScenarioDto) {
    return this.scenarios.create(user.userId, user.nickname, body);
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.scenarios.cancel(user.userId, id);
  }

  /** 취소했거나 종료된 시나리오만 지운다. */
  @Delete(":id")
  remove(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.scenarios.remove(user.userId, id);
  }
}

/** Internal endpoint used only by the local bots process. */
@Controller("internal/scenarios")
export class InternalScenarioController {
  constructor(private scenarios: ScenarioService) {}

  @Get("active")
  active(@Headers("x-liquidity-bootstrap-token") token?: string) {
    return this.scenarios.internalActive(token);
  }
}

/** 관리자 전용: 봇이 스스로 돌리는 자동 장세의 지금 국면(다음 국면·종료 시각은 없다). */
@Controller("admin/market-cycle")
@UseGuards(JwtAuthGuard)
export class AdminMarketCycleController {
  constructor(private cycles: MarketCycleService) {}

  @Get()
  current(@CurrentUser() user: JwtUser) {
    return this.cycles.current(user.userId);
  }
}

/** Internal endpoint: the bots report the current automatic market cycle once a minute. */
@Controller("internal/market-cycle")
export class InternalMarketCycleController {
  constructor(private cycles: MarketCycleService) {}

  @Post()
  receive(@Headers("x-liquidity-bootstrap-token") token: string | undefined, @Body() body: unknown) {
    return this.cycles.receive(token, body);
  }
}
