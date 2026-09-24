import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { assertTradingOpen } from "../common/maintenance-window";
import { BracketService, type BracketSpec } from "./bracket.service";
import { OrderService, type PlaceOrderDto } from "./order.service";

@Controller("orders")
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(
    private orders: OrderService,
    private bracket: BracketService,
  ) {}

  /**
   * `bracket`이 오면 매수 주문에 "체결 후 손절/익절 자동 등록" 의도를 붙인다. 의도는 주문이
   * 커밋된 뒤 별도로 저장되므로, 잘못된 bracket은 주문 전에 미리 검증해 둘 다 거부한다.
   */
  @Post()
  async place(
    @CurrentUser() user: JwtUser,
    @Body() body: PlaceOrderDto & { bracket?: BracketSpec },
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    assertTradingOpen();
    const spec = body.bracket ? BracketService.validateSpec(body.bracket) : null;
    if (spec && body.side !== "BUY") throw new BadRequestException("자동 손절/익절은 매수 주문에만 붙일 수 있습니다");
    // Idempotency-Key 헤더(1~128자)가 있으면 재시도가 두 번째 주문을 만들지 않는다.
    const key = idempotencyKey?.trim();
    if (key != null && (key.length === 0 || key.length > 128)) throw new BadRequestException("Idempotency-Key는 1~128자");
    const order = key ? await this.orders.placeIdempotent(user.accountId, body, key) : await this.orders.place(user.accountId, body);
    if (!spec || (order as { idempotentReplay?: boolean }).idempotentReplay) return order;
    const intent = await this.bracket.attach(user.accountId, order.id, order.symbol, spec);
    return { ...order, bracket: intent };
  }

  @Get("bracket")
  listBrackets(@CurrentUser() user: JwtUser, @Query("symbol") symbol?: string, @Query("limit") limit?: string) {
    return this.bracket.list(user.accountId, symbol || undefined, limit ? Number(limit) : undefined);
  }

  @Delete("bracket/:id")
  cancelBracket(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    assertTradingOpen();
    return this.bracket.cancel(user.accountId, id);
  }

  @Delete(":id")
  cancel(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    assertTradingOpen();
    return this.orders.cancel(user.accountId, id);
  }

  /** 지정가 정정(취소 후 남은 수량 재접수). body: { price?, qty? } — qty는 새 남은 수량. */
  @Patch(":id")
  amend(@CurrentUser() user: JwtUser, @Param("id") id: string, @Body() body: { price?: number; qty?: number }) {
    assertTradingOpen();
    return this.orders.amend(user.accountId, id, body);
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
