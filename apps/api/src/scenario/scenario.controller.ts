import { Body, Controller, Get, Headers, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
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
