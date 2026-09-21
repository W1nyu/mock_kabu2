import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { ConditionalOrderService, type PlaceConditionalOrderDto } from "./conditional-order.service";

@Controller("orders/conditional")
@UseGuards(JwtAuthGuard)
export class ConditionalOrderController {
  constructor(private conditional: ConditionalOrderService) {}

  @Post()
  place(@CurrentUser() user: JwtUser, @Body() body: PlaceConditionalOrderDto) {
    return this.conditional.place(user.accountId, body);
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
    return this.conditional.cancel(user.accountId, id);
  }
}
