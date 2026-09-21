import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import type { PrismaClient } from "@mock-kabu/db";
import {
  KEYS,
  MARKET_BUY_HOLD_FACTOR,
  SYMBOLS,
  isOnTick,
  tickSizeOf,
  type OrderCancelRequestedEvent,
  type OrderPlacedEvent,
  type OrderSide,
  type OrderType,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { BALANCE_MUTATOR, PRISMA, REDIS } from "../core/tokens";
import { RealtimeGateway } from "../gateway/realtime.gateway";
import { OutboxRelayer } from "./outbox.relayer";

export interface PlaceOrderDto {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: number;
  qty: number;
}

export interface MyOrdersFilter {
  /** Restrict the account-owned order list to one market symbol. */
  symbol?: string;
  /** Only orders that can still appear in the matching engine's book. */
  liveOnly?: boolean;
}

const LIVE_ORDER_STATUSES = ["OPEN", "PARTIAL"];

@Injectable()
export class OrderService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    @Inject(REDIS) private redis: Redis,
    private realtime: RealtimeGateway,
    private outboxRelayer?: OutboxRelayer,
  ) {}

  /** 주문 접수 — 잔액/보유 홀드(락 적용) + orders/outbox 동일 트랜잭션 (스펙 3.2의 1~2단계) */
  async place(accountId: string, dto: PlaceOrderDto) {
    const { symbol, side, type } = dto;
    const qty = Number(dto.qty);
    const price = dto.price != null ? Number(dto.price) : null;

    if (!["BUY", "SELL"].includes(side)) throw new BadRequestException("side는 BUY/SELL");
    if (!["LIMIT", "MARKET"].includes(type)) throw new BadRequestException("type은 LIMIT/MARKET");
    if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestException("수량은 양의 정수");
    if (type === "LIMIT" && (!Number.isInteger(price) || price! <= 0)) {
      throw new BadRequestException("지정가는 양의 정수");
    }
    if (!SYMBOLS.some((definition) => definition.symbol === symbol)) {
      throw new NotFoundException(`없는 종목: ${symbol}`);
    }
    // 격자 밖 지정가는 호가창에 낯선 단계를 만들고 봇 래더와 어긋나므로 접수 단계에서 막는다.
    const tickSize = tickSizeOf(symbol);
    if (type === "LIMIT" && tickSize != null && !isOnTick(price!, tickSize)) {
      throw new BadRequestException(`${symbol}의 호가 단위는 ${tickSize.toLocaleString("ko-KR")}원입니다`);
    }

    const marketSymbol = await this.prisma.marketSymbol.findUnique({ where: { symbol } });
    if (!marketSymbol) throw new NotFoundException(`없는 종목: ${symbol}`);

    // BUY 홀드 단가: LIMIT=지정가, MARKET=최근가*안전계수(체결 상한으로도 사용)
    const holdPerUnit =
      side === "BUY"
        ? BigInt(type === "LIMIT" ? price! : Math.ceil(marketSymbol.lastPrice * MARKET_BUY_HOLD_FACTOR))
        : 0n;

    const order = await this.mutator.withAccountLock([accountId], async (ctx) => {
      if (side === "BUY") {
        const acc = ctx.accounts[accountId];
        const holdTotal = holdPerUnit * BigInt(qty);
        const available = acc.balance - acc.holdAmount;
        if (available < holdTotal) {
          throw new UnprocessableEntityException("주문 가능 금액이 부족합니다");
        }
        await ctx.updateAccount(accountId, {
          balance: acc.balance,
          holdAmount: acc.holdAmount + holdTotal,
        });
      } else {
        const holding = await ctx.tx.holding.findUnique({
          where: { accountId_symbol: { accountId, symbol } },
        });
        const availableQty = holding ? holding.qty - holding.holdQty : 0;
        if (availableQty < qty) {
          throw new UnprocessableEntityException("매도 가능 수량이 부족합니다");
        }
        await ctx.tx.holding.update({
          where: { accountId_symbol: { accountId, symbol } },
          data: { holdQty: { increment: qty } },
        });
        // 계좌 잔액은 그대로지만 낙관적 전략의 version touch로 직렬화된다
      }

      const order = await ctx.tx.order.create({
        data: { accountId, symbol, side, type, price, qty, holdPerUnit },
      });

      const event: OrderPlacedEvent = {
        topic: "order.placed",
        eventId: randomUUID(),
        orderId: order.id,
        accountId,
        symbol,
        side,
        type,
        // MARKET BUY는 홀드 단가를 체결 상한으로 전달 (홀드 초과 체결 방지)
        price: type === "LIMIT" ? price : side === "BUY" ? Number(holdPerUnit) : null,
        qty,
        ts: Date.now(),
      };
      await ctx.tx.outbox.create({
        data: { eventId: event.eventId, topic: event.topic, payload: event as object },
      });

      return order;
    });

    this.outboxRelayer?.flushSoon();
    this.realtime.notifyAccount(accountId, { type: "account_update" });
    return order;
  }

  /** 주문 취소 요청 — 실제 종결/홀드 해제는 매칭 엔진의 order.closed 이벤트가 처리 */
  async cancel(accountId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException("주문을 찾을 수 없습니다");
    if (order.accountId !== accountId) throw new ForbiddenException("본인 주문만 취소할 수 있습니다");
    if (!["OPEN", "PARTIAL"].includes(order.status)) {
      throw new UnprocessableEntityException(`이미 종결된 주문입니다 (${order.status})`);
    }

    const event: OrderCancelRequestedEvent = {
      topic: "order.cancel.requested",
      eventId: randomUUID(),
      orderId,
      symbol: order.symbol,
      ts: Date.now(),
    };
    await this.prisma.outbox.create({
      data: { eventId: event.eventId, topic: event.topic, payload: event as object },
    });
    this.outboxRelayer?.flushSoon();
    return { ok: true };
  }

  async myOrders(accountId: string, limit = 50, filter: MyOrdersFilter = {}) {
    const symbol = filter.symbol?.trim() || undefined;
    return this.prisma.order.findMany({
      where: {
        accountId,
        ...(symbol ? { symbol } : {}),
        ...(filter.liveOnly ? { status: { in: LIVE_ORDER_STATUSES } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
    });
  }

  /**
   * Market-maker reconciliation needs both its durable live orders and the
   * matching engine's latest snapshot. Serving them from one authenticated
   * endpoint halves the hot-path HTTP work without making Redis authoritative
   * for account-owned orders.
   */
  async liveQuoteState(accountId: string, rawSymbol?: string) {
    const symbol = rawSymbol?.trim() || "";
    if (!SYMBOLS.some((definition) => definition.symbol === symbol)) {
      throw new NotFoundException(`없는 종목: ${symbol || "(empty)"}`);
    }

    const [orders, cachedBook] = await Promise.all([
      this.myOrders(accountId, 200, { symbol, liveOnly: true }),
      this.redis.get(KEYS.orderbookSnapshot(symbol)),
    ]);
    if (cachedBook) return { orders, orderbook: JSON.parse(cachedBook) };

    // During a matching-engine bootstrap the snapshot can legitimately be
    // absent. Return an empty, price-correct view so makers do not need a
    // second retrying endpoint solely for this short window.
    const market = await this.prisma.marketSymbol.findUnique({ where: { symbol } });
    if (!market) throw new NotFoundException(`없는 종목: ${symbol}`);
    return {
      orders,
      orderbook: { symbol, bids: [], asks: [], lastPrice: market.lastPrice, seq: 0, ts: Date.now() },
    };
  }
}
