import { Body, Controller, Delete, Get, Header, Param, Post, Query, UseGuards } from "@nestjs/common";
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

  /**
   * One authenticated read for a market maker's own live rows and the public
   * executable snapshot. This avoids two high-frequency REST round trips per
  * symbol while retaining the ordinary `/orders` response for all clients.
  */
  @Get("quote-state")
  @Header("Cache-Control", "no-store")
  quoteState(@CurrentUser() user: JwtUser, @Query("symbol") symbol?: string) {
    return this.orders.liveQuoteState(user.accountId, symbol);
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
