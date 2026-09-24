import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { assertTradingOpen } from "../common/maintenance-window";
import {
  ConditionalOrderService,
  type PlaceConditionalOrderDto,
  type PlaceOcoDto,
} from "./conditional-order.service";

@Controller("orders/conditional")
@UseGuards(JwtAuthGuard)
export class ConditionalOrderController {
  constructor(private conditional: ConditionalOrderService) {}

  @Post()
  place(@CurrentUser() user: JwtUser, @Body() body: PlaceConditionalOrderDto) {
    assertTradingOpen();
    return this.conditional.place(user.accountId, body);
  }

  /** 손절+익절(또는 눌림+돌파) 한 쌍. 한쪽이 발동하면 다른 쪽은 자동 취소. */
  @Post("oco")
  placeOco(@CurrentUser() user: JwtUser, @Body() body: PlaceOcoDto) {
    assertTradingOpen();
    return this.conditional.placeOco(user.accountId, body);
  }

  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query("symbol") symbol?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    return this.conditional.list(user.accountId, { symbol, status, limit: limit ? Number(limit) : undefined });
  }

  @Delete(":id")
  cancel(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    assertTradingOpen();
    return this.conditional.cancel(user.accountId, id);
  }
}
