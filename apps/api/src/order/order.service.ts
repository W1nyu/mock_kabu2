import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import { isTradingFeeExempt, type PrismaClient } from "@mock-kabu/db";
import {
  KEYS,
  MARKET_BUY_HOLD_FACTOR,
  MAX_ORDER_PRICE,
  MAX_FUTURES_ORDER_QTY,
  MAX_ORDER_QTY,
  TRADABLE_SYMBOLS,
  formatFuturePrice,
  futureDef,
  optionDef,
  orderHoldWithFee,
  TRADING_FEES_EFFECTIVE_AT,
  isOnTick,
  tickSizeOf,
  type OrderCancelRequestedEvent,
  type OrderPlacedEvent,
  type OrderSide,
  type OrderType,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { BALANCE_MUTATOR, PRISMA, REDIS } from "../core/tokens";
import { OptionsService } from "../futures/options.service";
import { RealtimeGateway } from "../gateway/realtime.gateway";
import { futuresMarginHeld, futuresOrderHoldPerUnit, optionOrderHoldPerUnit } from "./futures-margin";
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
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/**
 * 같은 주문의 취소 요청은 이 시간 안에 한 번만 outbox에 쓴다. 취소는 비동기라 주문이 한동안 OPEN으로 보이는데,
 * 봇·사용자가 그 사이 DELETE를 다시 보내면 요청마다 이벤트가 쌓였다. 엔진이 밀리면 취소가 늦게 반영되고,
 * 그래서 또 다시 보내는 되먹임으로 outbox가 수십만 건까지 불어난 적이 있다(로컬 2026-09-25, 약 900건/초).
 * 첫 요청은 outbox에 영속되므로 중복을 버려도 취소는 잃지 않는다. 이 시간이 지나면 다시 받아 준다.
 */
const CANCEL_DEDUPE_SECONDS = 30;

/** 호가 단위 안내: 현물은 원, 선물·옵션은 정수 단위를 실제 가격으로 */
function tickText(symbol: string, units: number): string {
  const def = futureDef(symbol) ?? optionDef(symbol);
  return def ? formatFuturePrice(def, units) : `${units.toLocaleString("ko-KR")}원`;
}

@Injectable()
export class OrderService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    @Inject(REDIS) private redis: Redis,
    private realtime: RealtimeGateway,
    @Optional() private outboxRelayer?: OutboxRelayer,
    // OptionsService는 FuturesModule(이 모듈을 import한다)에 있어 직접 주입하면 순환이 된다 — 쓸 때 찾아온다.
    @Optional() private moduleRef?: ModuleRef,
  ) {}

  /**
   * 옵션 시장가 체결 한도의 기준가 = 지금 이론가. 최근가는 체결이 없으면 옛 값에 머물러(하루 만기라 시간가치가 빠르게 준다)
   * 한도가 마켓메이커 호가(이론가 근처)를 벗어나면 시장가가 체결 없이 취소되고, 그래서 최근가가 또 안 바뀌었다.
   * 이론가를 구할 수 없으면 최근가.
   */
  private async optionMarketReference(symbol: string, lastPrice: number): Promise<number> {
    try {
      const options = this.moduleRef?.get(OptionsService, { strict: false });
      const row = options ? (await options.overview()).find((r) => r.symbol === symbol) : undefined;
      return row?.theo ?? lastPrice;
    } catch {
      return lastPrice;
    }
  }

  /**
   * 멱등 키가 있으면 같은 키로 이미 접수된 주문을 돌려준다. 키 선점(SET NX)은 접수 전에 하고,
   * 접수가 실패하면 키를 지워 클라이언트가 같은 키로 다시 시도할 수 있게 한다.
   */
  async placeIdempotent(accountId: string, dto: PlaceOrderDto, idempotencyKey: string) {
    const key = KEYS.orderIdempotency(accountId, idempotencyKey);
    const claimed = await this.redis.set(key, "pending", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    if (claimed !== "OK") {
      const existing = await this.waitForIdempotentOrder(key);
      if (existing) return { ...existing, idempotentReplay: true };
      throw new UnprocessableEntityException("같은 멱등 키의 주문이 아직 처리 중입니다. 잠시 후 다시 조회하세요");
    }
    try {
      const order = await this.place(accountId, dto);
      await this.redis.set(key, order.id, "EX", IDEMPOTENCY_TTL_SECONDS);
      return order;
    } catch (error) {
      await this.redis.del(key).catch(() => {});
      throw error;
    }
  }

  private async waitForIdempotentOrder(key: string) {
    // 동시에 들어온 재시도는 첫 요청이 주문 ID를 쓰기까지 잠깐 기다린다.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = await this.redis.get(key);
      if (value && value !== "pending") {
        return this.prisma.order.findUnique({ where: { id: value } });
      }
      if (value == null) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /** 주문 접수 — 잔액/보유 홀드(락 적용) + orders/outbox 동일 트랜잭션 (스펙 3.2의 1~2단계) */
  async place(accountId: string, dto: PlaceOrderDto) {
    const { symbol, side, type } = dto;
    const qty = Number(dto.qty);
    const price = dto.price != null ? Number(dto.price) : null;

    if (!["BUY", "SELL"].includes(side)) throw new BadRequestException("side는 BUY/SELL");
    if (!["LIMIT", "MARKET"].includes(type)) throw new BadRequestException("type은 LIMIT/MARKET");
    if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestException("수량은 양의 정수");
    if (qty > MAX_ORDER_QTY) throw new BadRequestException(`한 주문의 수량은 ${MAX_ORDER_QTY.toLocaleString("ko-KR")}주까지입니다`);
    if (type === "LIMIT" && (!Number.isInteger(price) || price! <= 0)) {
      throw new BadRequestException("지정가는 양의 정수");
    }
    if (type === "LIMIT" && price! > MAX_ORDER_PRICE) {
      throw new BadRequestException(`지정가는 ${MAX_ORDER_PRICE.toLocaleString("ko-KR")}원까지입니다`);
    }
    if (!TRADABLE_SYMBOLS.includes(symbol)) {
      throw new NotFoundException(`없는 종목: ${symbol}`);
    }
    const future = futureDef(symbol);
    const option = optionDef(symbol);
    if ((future || option) && qty > MAX_FUTURES_ORDER_QTY) {
      throw new BadRequestException(`${option ? "옵션" : "선물"}은 한 주문에 ${MAX_FUTURES_ORDER_QTY}계약까지입니다`);
    }
    // 격자 밖 지정가는 호가창에 낯선 단계를 만들고 봇 래더와 어긋나므로 접수 단계에서 막는다.
    const tickSize = tickSizeOf(symbol);
    if (type === "LIMIT" && tickSize != null && !isOnTick(price!, tickSize)) {
      throw new BadRequestException(`${symbol}의 호가 단위는 ${tickText(symbol, tickSize)}입니다`);
    }

    const marketSymbol = await this.prisma.marketSymbol.findUnique({ where: { symbol } });
    if (!marketSymbol) throw new NotFoundException(`없는 종목: ${symbol}`);

    // 시장가 체결 상한(정수 가격 단위): 최근가 × 안전계수. 현물 매수는 이 값이 곧 홀드 단가다.
    // 옵션은 가격이 짧은 시간에 크게 움직여 체결 상한을 넉넉히 둔다(이론가 × 1.5 + 10호가, optionMarketReference).
    const optionReference = option && type === "MARKET" ? await this.optionMarketReference(symbol, marketSymbol.lastPrice) : marketSymbol.lastPrice;
    const marketCap = option
      ? Math.ceil(optionReference * 1.5) + option.tickUnits * 10
      : Math.ceil(marketSymbol.lastPrice * MARKET_BUY_HOLD_FACTOR);
    // 홀드 단가(원/주, 원/계약):
    //  - 현물 BUY: LIMIT=지정가, MARKET=체결 상한. 현물 SELL은 현금이 아니라 보유 수량을 묶는다.
    //  - 선물: 계약당 위탁증거금(계좌·종목의 레버리지 반영). 보유 포지션을 줄이기만 하는 청산 주문은 0 —
    //    실제 증권사처럼 청산에는 증거금이 필요 없다. 계좌 락 안에서 포지션을 읽어 정한다.
    let holdPerUnit = future ? 0n : side === "BUY" ? BigInt(type === "LIMIT" ? price! : marketCap) : 0n;

    const order = await this.mutator.withAccountLock([accountId], async (ctx) => {
      if (future) {
        holdPerUnit = await futuresOrderHoldPerUnit(ctx.tx, accountId, future, side, qty, type === "LIMIT" ? price! : marketCap);
      } else if (option) {
        holdPerUnit = await optionOrderHoldPerUnit(ctx.tx, accountId, option, side, qty, type === "LIMIT" ? price! : marketCap);
      }
      if (holdPerUnit > 0n && Date.now() >= TRADING_FEES_EFFECTIVE_AT && !(await isTradingFeeExempt(ctx.tx, accountId))) {
        holdPerUnit = orderHoldWithFee(holdPerUnit, symbol, type === "LIMIT" ? price! : marketCap);
      }
      if (future || option || side === "BUY") {
        const acc = ctx.accounts[accountId];
        const holdTotal = holdPerUnit * BigInt(qty);
        const available = acc.balance - acc.holdAmount - (await futuresMarginHeld(ctx.tx, accountId));
        if (holdTotal > 0n && available < holdTotal) {
          throw new UnprocessableEntityException(
            future ? "주문 증거금이 부족합니다" : option && side === "SELL" ? "쓰기 증거금이 부족합니다" : "주문 가능 금액이 부족합니다",
          );
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
        // MARKET BUY는 체결 상한을 전달 (홀드 초과 체결 방지). 선물 홀드는 증거금이라 상한과 따로 계산한다.
        // 옵션 시장가 매도는 이론가의 절반을 하한으로 — 호가가 비어도 1호가에 던지지 않게.
        // 선물 시장가 매도는 매수 상한(최근가 × 1.1)과 대칭인 최근가 ÷ 1.1을 하한으로(반대매매와 같은 보호 한도).
        price:
          type === "LIMIT"
            ? price
            : side === "BUY"
              ? marketCap
              : option
                ? Math.max(option.tickUnits, Math.floor(optionReference / 2))
                : future
                  ? Math.max(future.tickUnits, Math.floor(marketSymbol.lastPrice / MARKET_BUY_HOLD_FACTOR))
                  : null,
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

    // Redis가 잠깐 안 되면 막지 않고 예전처럼 그냥 쓴다(엔진은 중복 취소를 멱등하게 처리한다).
    const dedupeKey = KEYS.cancelRequested(orderId);
    const fresh = await this.redis.set(dedupeKey, "1", "EX", CANCEL_DEDUPE_SECONDS, "NX").catch(() => "OK");
    if (fresh !== "OK") return { ok: true, duplicate: true };

    const event: OrderCancelRequestedEvent = {
      topic: "order.cancel.requested",
      eventId: randomUUID(),
      orderId,
      symbol: order.symbol,
      ts: Date.now(),
    };
    try {
      await this.prisma.outbox.create({
        data: { eventId: event.eventId, topic: event.topic, payload: event as object },
      });
    } catch (error) {
      await this.redis.del(dedupeKey).catch(() => undefined);
      throw error;
    }
    this.outboxRelayer?.flushSoon();
    return { ok: true };
  }

  /**
   * 정정 = 취소 + 재접수. 매칭 엔진이 단일 writer라 원자적 교체는 없다: 먼저 취소를 요청하고
   * 주문이 실제로 종결된 것을 확인한 뒤에야 남은 수량으로 새 지정가를 낸다. 확인 전에 체결돼
   * 버리면 새 주문을 내지 않고 그 사실을 돌려준다(이중 홀드·이중 체결 방지).
   */
  async amend(accountId: string, orderId: string, changes: { price?: number; qty?: number }) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException("주문을 찾을 수 없습니다");
    if (order.accountId !== accountId) throw new ForbiddenException("본인 주문만 정정할 수 있습니다");
    if (!LIVE_ORDER_STATUSES.includes(order.status)) {
      throw new UnprocessableEntityException(`이미 종결된 주문입니다 (${order.status})`);
    }
    if (order.type !== "LIMIT" || order.price == null) {
      throw new BadRequestException("지정가 주문만 정정할 수 있습니다");
    }

    const remaining = order.qty - order.filledQty;
    const price = changes.price != null ? Number(changes.price) : order.price;
    const qty = changes.qty != null ? Number(changes.qty) : remaining;
    if (!Number.isInteger(price) || price <= 0) throw new BadRequestException("정정 가격은 양의 정수");
    if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestException("정정 수량은 양의 정수");
    const tickSize = tickSizeOf(order.symbol);
    if (tickSize != null && !isOnTick(price, tickSize)) {
      throw new BadRequestException(`${order.symbol}의 호가 단위는 ${tickText(order.symbol, tickSize)}입니다`);
    }
    if (price === order.price && qty === remaining) {
      throw new BadRequestException("바뀐 내용이 없습니다");
    }

    await this.cancel(accountId, orderId);
    const closed = await this.waitUntilClosed(orderId, 4_000);
    if (!closed) {
      throw new UnprocessableEntityException("취소 확인이 지연돼 새 주문을 내지 않았습니다. 잠시 후 다시 시도하세요");
    }
    const unfilled = closed.qty - closed.filledQty;
    if (closed.status === "FILLED" || unfilled <= 0) {
      return { amended: false, reason: "취소 전에 전량 체결됐습니다", canceled: closed, order: null };
    }
    // 취소 확인 사이에 일부가 체결됐으면 정정 수량은 그 남은 양을 넘을 수 없다.
    const nextQty = Math.min(qty, unfilled);
    const placed = await this.place(accountId, {
      symbol: order.symbol,
      side: order.side as OrderSide,
      type: "LIMIT",
      price,
      qty: nextQty,
    });
    return { amended: true, reason: null, canceled: closed, order: placed };
  }

  private async waitUntilClosed(orderId: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const row = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (row && !LIVE_ORDER_STATUSES.includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
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
      // 마켓메이커는 계정의 살아 있는 주문 전부를 한 번에 읽는다(옵션 44종목 × 호가 여러 단).
      take: Math.min(limit, filter.liveOnly ? 500 : 200),
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
    if (!TRADABLE_SYMBOLS.includes(symbol)) {
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
