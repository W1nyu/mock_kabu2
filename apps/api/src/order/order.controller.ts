import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { OrderService, type PlaceOrderDto } from "./order.service";

@Controller("orders")
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private orders: OrderService) {}

  @Post()
  place(@CurrentUser() user: JwtUser, @Body() body: PlaceOrderDto) {
    return this.orders.place(user.accountId, body);
  }

  @Delete(":id")
  cancel(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.orders.cancel(user.accountId, id);
  }

  @Get()
  myOrders(
    @CurrentUser() user: JwtUser,
    @Query("limit") limit?: string,
    @Query("symbol") symbol?: string,
    @Query("status") status?: string,
  ) {
    // Existing /orders calls keep their all-status behavior.  status=live is
    // purpose-built for market makers that must not page through history.
    return this.orders.myOrders(user.accountId, limit ? Number(limit) : undefined, {
      symbol,
      liveOnly: status === "live",
    });
  }
}
