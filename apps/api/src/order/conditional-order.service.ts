import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  CHANNELS,
  REDIS_CHANNEL_PATTERNS,
  SYMBOLS,
  TRAIL_BPS_MAX,
  TRAIL_BPS_MIN,
  advancesWatermark,
  conditionMet,
  describeCondition,
  trailingTrigger,
  type ConditionalOrderDto,
  type OrderSide,
  type OrderType,
  type TriggerDirection,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { BackgroundStatusRegistry } from "../core/background-status";
import { PRISMA, REDIS_SUB } from "../core/tokens";
import { RealtimeGateway } from "../gateway/realtime.gateway";
import { OrderService } from "./order.service";

export interface PlaceConditionalOrderDto {
  symbol: string;
  side: OrderSide;
  /** 트레일링이면 생략 가능 — 매도는 AT_OR_BELOW, 매수는 AT_OR_ABOVE로 고정된다 */
  direction?: TriggerDirection;
  /** 트레일링이면 생략 — 현재가 기준 watermark에서 계산된다 */
  triggerPrice?: number;
  qty: number;
  orderType?: OrderType;
  limitPrice?: number;
  /** 트레일링 스탑 거리(bps, 10~5000). 있으면 트리거가 고점/저점을 따라 움직인다 */
  trailBps?: number;
}

export interface PlaceOcoDto {
  symbol: string;
  side: OrderSide;
  qty: number;
  /** 손절(매도) / 눌림(매수) 다리 — 현재가 아래에서 AT_OR_BELOW로 발동 */
  lowerPrice: number;
  /** 익절(매도) / 돌파(매수) 다리 — 현재가 위에서 AT_OR_ABOVE로 발동 */
  upperPrice: number;
}

interface WaitingRow {
  id: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  direction: TriggerDirection;
  triggerPrice: number;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
  ocoGroupId: string | null;
  trailBps: number | null;
  watermark: number | null;
}

const OCO_SIBLING_NOTE = "OCO 짝 주문 발동으로 자동 취소";

/** 다른 API 인스턴스가 만든 대기 주문을 늦어도 이 간격 안에 메모리 인덱스로 가져온다. */
const INDEX_REFRESH_MS = 10_000;
const MAX_WAITING_PER_ACCOUNT = 50;
const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

/**
 * 조건부(예약) 주문 감시자.
 *
 * 체결 Pub/Sub(`trades:{symbol}`)을 구독해 대기 주문의 조건을 검사하고, 만족하면
 * WAITING→TRIGGERED로 DB claim(정확히 한 번)한 뒤 일반 주문 경로(`OrderService.place`)로
 * 접수한다. 대기 중에는 아무것도 홀드하지 않으므로 접수 시점의 잔액/보유 검증에서
 * 거부될 수 있고, 그 경우 FAILED와 사유를 남긴다.
 */
@Injectable()
export class ConditionalOrderService implements OnModuleInit, OnModuleDestroy {
  /** symbol → id → 대기 주문. 한 프로세스가 같은 행을 두 번 발동시키지 않도록 발동 전에 먼저 지운다. */
  private readonly waiting = new Map<string, Map<string, WaitingRow>>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number | null = null;
  private triggeredCount = 0;
  private failedCount = 0;
  private readonly onMessage = (_pattern: string, channel: string, message: string) => {
    const symbol = this.symbolFromTradeChannel(channel);
    if (!symbol) return;
    this.lastTickAt = Date.now();
    try {
      const tick = JSON.parse(message) as { price?: unknown };
      if (typeof tick.price === "number" && Number.isFinite(tick.price)) this.onTick(symbol, tick.price);
    } catch {
      // 다른 채널/손상 페이로드는 무시한다. 가격이 없으면 발동할 근거도 없다.
    }
  };

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS_SUB) private sub: Redis,
    private orders: OrderService,
    private realtime: RealtimeGateway,
    @Optional() private background?: BackgroundStatusRegistry,
  ) {}

  async onModuleInit() {
    this.background?.register("conditionalOrders", () => ({
      status: "up",
      waiting: [...this.waiting.values()].reduce((sum, rows) => sum + rows.size, 0),
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      triggered: this.triggeredCount,
      failed: this.failedCount,
    }));
    await this.reloadIndex();
    this.sub.on("pmessage", this.onMessage);
    // 게이트웨이도 같은 패턴을 구독하지만 Redis는 클라이언트별로 중복 없이 관리한다.
    await this.sub.psubscribe(REDIS_CHANNEL_PATTERNS.trades).catch((error) => {
      console.error("[conditional] psubscribe failed", error);
    });
    // 내려가 있는 동안 조건을 지나친 주문은 현재가 기준으로 바로 검사한다.
    await this.evaluateAgainstLastPrices();
    this.refreshTimer = setInterval(() => {
      void this.reloadIndex().then(() => this.evaluateAgainstLastPrices());
    }, INDEX_REFRESH_MS);
  }

  onModuleDestroy() {
    this.background?.unregister("conditionalOrders");
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.sub.off("pmessage", this.onMessage);
  }

  async place(accountId: string, dto: PlaceConditionalOrderDto): Promise<ConditionalOrderDto> {
    const { symbol, side } = dto;
    const qty = Number(dto.qty);
    const orderType: OrderType = dto.orderType ?? "MARKET";
    const limitPrice = dto.limitPrice != null ? Number(dto.limitPrice) : null;
    const trailBps = dto.trailBps != null ? Number(dto.trailBps) : null;

    this.assertSymbolSideQty(symbol, side, qty);
    if (orderType !== "MARKET" && orderType !== "LIMIT") throw new BadRequestException("orderType은 MARKET/LIMIT");
    if (orderType === "LIMIT" && (!Number.isInteger(limitPrice) || limitPrice! <= 0)) {
      throw new BadRequestException("지정가는 양의 정수");
    }
    if (trailBps != null && (!Number.isInteger(trailBps) || trailBps < TRAIL_BPS_MIN || trailBps > TRAIL_BPS_MAX)) {
      throw new BadRequestException(`트레일링 거리는 ${TRAIL_BPS_MIN / 100}%~${TRAIL_BPS_MAX / 100}% 사이여야 합니다`);
    }

    const lastPrice = await this.lastPriceOf(symbol);
    let direction: TriggerDirection;
    let triggerPrice: number;
    let watermark: number | null = null;
    if (trailBps != null) {
      // 트레일링은 등록 시점 현재가를 기준 극값으로 삼는다. 방향은 매도=아래, 매수=위로 정해진다.
      direction = side === "SELL" ? "AT_OR_BELOW" : "AT_OR_ABOVE";
      watermark = lastPrice;
      triggerPrice = trailingTrigger(side, watermark, trailBps);
      if (conditionMet(direction, triggerPrice, lastPrice)) {
        throw new BadRequestException("트레일링 거리가 너무 좁아 등록 즉시 발동합니다");
      }
    } else {
      direction = dto.direction as TriggerDirection;
      triggerPrice = Number(dto.triggerPrice);
      if (direction !== "AT_OR_ABOVE" && direction !== "AT_OR_BELOW") {
        throw new BadRequestException("direction은 AT_OR_ABOVE/AT_OR_BELOW");
      }
      if (!Number.isInteger(triggerPrice) || triggerPrice <= 0) throw new BadRequestException("트리거 가격은 양의 정수");
      this.assertNotAlreadyMet(direction, triggerPrice, lastPrice);
    }
    await this.assertWaitingCapacity(accountId, 1);

    const row = await this.prisma.conditionalOrder.create({
      data: {
        accountId,
        symbol,
        side,
        direction,
        triggerPrice,
        qty,
        orderType,
        limitPrice: orderType === "LIMIT" ? limitPrice : null,
        trailBps,
        watermark,
      },
    });
    this.index(row);
    this.realtime.notifyAccount(accountId, { type: "conditional", id: row.id, status: row.status });
    return toDto(row);
  }

  /**
   * OCO 한 쌍: 현재가 아래 다리(AT_OR_BELOW)와 위 다리(AT_OR_ABOVE)를 같은 그룹으로 등록한다.
   * 매도면 손절+익절, 매수면 눌림+돌파. 한쪽이 발동하면 다른 쪽은 자동 취소된다.
   */
  async placeOco(accountId: string, dto: PlaceOcoDto): Promise<ConditionalOrderDto[]> {
    const { symbol, side } = dto;
    const qty = Number(dto.qty);
    const lowerPrice = Number(dto.lowerPrice);
    const upperPrice = Number(dto.upperPrice);
    this.assertSymbolSideQty(symbol, side, qty);
    if (!Number.isInteger(lowerPrice) || lowerPrice <= 0 || !Number.isInteger(upperPrice) || upperPrice <= 0) {
      throw new BadRequestException("트리거 가격은 양의 정수");
    }
    if (lowerPrice >= upperPrice) throw new BadRequestException("아래 트리거는 위 트리거보다 낮아야 합니다");

    const lastPrice = await this.lastPriceOf(symbol);
    this.assertNotAlreadyMet("AT_OR_BELOW", lowerPrice, lastPrice);
    this.assertNotAlreadyMet("AT_OR_ABOVE", upperPrice, lastPrice);
    await this.assertWaitingCapacity(accountId, 2);

    const ocoGroupId = randomUUID();
    const legs = [
      { direction: "AT_OR_BELOW" as const, triggerPrice: lowerPrice },
      { direction: "AT_OR_ABOVE" as const, triggerPrice: upperPrice },
    ];
    const rows = await this.prisma.$transaction(
      legs.map((leg) =>
        this.prisma.conditionalOrder.create({
          data: { accountId, symbol, side, qty, orderType: "MARKET", ocoGroupId, ...leg },
        }),
      ),
    );
    for (const row of rows) this.index(row);
    this.realtime.notifyAccount(accountId, { type: "conditional", id: ocoGroupId, status: "WAITING" });
    return rows.map(toDto);
  }

  private assertSymbolSideQty(symbol: string, side: string, qty: number): void {
    if (!ACTIVE_SYMBOLS.has(symbol)) throw new NotFoundException(`없는 종목: ${symbol}`);
    if (side !== "BUY" && side !== "SELL") throw new BadRequestException("side는 BUY/SELL");
    if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestException("수량은 양의 정수");
  }

  private async lastPriceOf(symbol: string): Promise<number> {
    const marketSymbol = await this.prisma.marketSymbol.findUnique({ where: { symbol } });
    if (!marketSymbol) throw new NotFoundException(`없는 종목: ${symbol}`);
    return marketSymbol.lastPrice;
  }

  /** 이미 만족하는 조건은 예약의 의미가 없다 — 바로 일반 주문을 내라고 안내한다. */
  private assertNotAlreadyMet(direction: TriggerDirection, triggerPrice: number, lastPrice: number): void {
    if (conditionMet(direction, triggerPrice, lastPrice)) {
      throw new BadRequestException(
        `현재가 ${lastPrice.toLocaleString("ko-KR")}원이 이미 ${triggerPrice.toLocaleString("ko-KR")}원 ${
          direction === "AT_OR_ABOVE" ? "이상" : "이하"
        } 조건을 만족합니다. 일반 주문을 이용하세요`,
      );
    }
  }

  private async assertWaitingCapacity(accountId: string, adding: number): Promise<void> {
    const waitingCount = await this.prisma.conditionalOrder.count({ where: { accountId, status: "WAITING" } });
    if (waitingCount + adding > MAX_WAITING_PER_ACCOUNT) {
      throw new BadRequestException(`대기 중인 예약 주문은 계정당 ${MAX_WAITING_PER_ACCOUNT}건까지입니다`);
    }
  }

  async cancel(accountId: string, id: string): Promise<ConditionalOrderDto> {
    const existing = await this.prisma.conditionalOrder.findUnique({ where: { id } });
    if (!existing || existing.accountId !== accountId) throw new NotFoundException("예약 주문을 찾을 수 없습니다");
    if (existing.status !== "WAITING") {
      throw new BadRequestException("이미 발동됐거나 취소된 예약 주문입니다");
    }
    // 발동 중인 다른 인스턴스와 경합하면 한쪽만 이긴다.
    const claimed = await this.prisma.conditionalOrder.updateMany({
      where: { id, status: "WAITING" },
      data: { status: "CANCELED" },
    });
    this.waiting.get(existing.symbol)?.delete(id);
    if (claimed.count === 0) throw new BadRequestException("이미 발동된 예약 주문입니다");
    // OCO는 한 몸이다 — 한 다리를 취소하면 짝도 함께 취소한다.
    if (existing.ocoGroupId) await this.cancelOcoSiblings(existing.ocoGroupId, id, "OCO 짝 주문 취소");
    const row = await this.prisma.conditionalOrder.findUniqueOrThrow({ where: { id } });
    this.realtime.notifyAccount(accountId, { type: "conditional", id, status: row.status });
    return toDto(row);
  }

  private async cancelOcoSiblings(ocoGroupId: string, exceptId: string, note: string): Promise<void> {
    const siblings = await this.prisma.conditionalOrder.findMany({
      where: { ocoGroupId, status: "WAITING", id: { not: exceptId } },
      select: { id: true, symbol: true },
    });
    if (siblings.length === 0) return;
    await this.prisma.conditionalOrder.updateMany({
      where: { id: { in: siblings.map((row) => row.id) }, status: "WAITING" },
      data: { status: "CANCELED", failReason: note },
    });
    for (const sibling of siblings) this.waiting.get(sibling.symbol)?.delete(sibling.id);
  }

  async list(accountId: string, filter: { symbol?: string; status?: string; limit?: number } = {}) {
    const symbol = filter.symbol?.trim();
    const status = filter.status?.trim().toUpperCase();
    const rows = await this.prisma.conditionalOrder.findMany({
      where: {
        accountId,
        ...(symbol ? { symbol } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(1, filter.limit ?? 100), 200),
    });
    return rows.map(toDto);
  }

  /** 체결가 하나로 해당 종목의 대기 주문을 검사한다. 발동 대상은 즉시 인덱스에서 제거된다. */
  onTick(symbol: string, price: number): void {
    const rows = this.waiting.get(symbol);
    if (!rows || rows.size === 0) return;
    for (const row of [...rows.values()]) {
      // 트레일링: 새 극값이면 먼저 기준을 옮긴다. 옮긴 뒤의 트리거는 현재가에서 더 멀어지므로
      // 같은 tick에 발동할 일은 없다.
      if (row.trailBps != null && row.watermark != null && advancesWatermark(row.side, row.watermark, price)) {
        row.watermark = price;
        row.triggerPrice = trailingTrigger(row.side, price, row.trailBps);
        this.persistTrail(row);
        continue;
      }
      if (!conditionMet(row.direction, row.triggerPrice, price)) continue;
      rows.delete(row.id);
      void this.trigger(row, price);
    }
  }

  /**
   * 옮겨진 기준을 DB에도 남긴다(재시작·목록 표시용). 아직 WAITING인 행만 갱신하므로 발동·취소와
   * 경합해도 상태를 되돌리지 않는다. 실패해도 메모리 값이 우선이라 발동 판정에는 영향이 없다.
   */
  private persistTrail(row: WaitingRow): void {
    void this.prisma.conditionalOrder
      .updateMany({
        where: { id: row.id, status: "WAITING" },
        data: { triggerPrice: row.triggerPrice, watermark: row.watermark },
      })
      .catch((error) => console.error(`[conditional] trailing update failed for ${row.id}`, error));
  }

  private async trigger(row: WaitingRow, price: number): Promise<void> {
    const label = describeCondition(row.direction, row.side);
    try {
      const claimed = await this.prisma.conditionalOrder.updateMany({
        where: { id: row.id, status: "WAITING" },
        data: { status: "TRIGGERED", triggeredAt: new Date(), triggerTradePrice: price },
      });
      // 취소됐거나 다른 인스턴스가 먼저 발동시켰다.
      if (claimed.count === 0) return;
      if (row.ocoGroupId) await this.cancelOcoSiblings(row.ocoGroupId, row.id, OCO_SIBLING_NOTE);

      let failReason: string | null = null;
      let triggeredOrderId: string | null = null;
      try {
        const order = await this.orders.place(row.accountId, {
          symbol: row.symbol,
          side: row.side,
          type: row.orderType,
          qty: row.qty,
          ...(row.orderType === "LIMIT" && row.limitPrice != null ? { price: row.limitPrice } : {}),
        });
        triggeredOrderId = order.id;
      } catch (error) {
        failReason = error instanceof HttpException ? String(error.message) : "주문 접수 실패";
        console.warn(`[conditional] ${label} ${row.symbol} ${row.qty}주 접수 실패 (${row.id}): ${failReason}`);
      }

      await this.prisma.conditionalOrder.update({
        where: { id: row.id },
        data: triggeredOrderId ? { triggeredOrderId } : { status: "FAILED", failReason },
      });
      if (triggeredOrderId) this.triggeredCount += 1;
      else this.failedCount += 1;
      this.realtime.notifyAccount(row.accountId, {
        type: "conditional",
        id: row.id,
        status: triggeredOrderId ? "TRIGGERED" : "FAILED",
        symbol: row.symbol,
        side: row.side,
        qty: row.qty,
        triggerPrice: row.triggerPrice,
        label,
        orderId: triggeredOrderId,
        failReason,
      });
    } catch (error) {
      // DB가 잠시 불안정하면 다음 인덱스 재적재 때 WAITING 행이 다시 검사된다.
      console.error(`[conditional] trigger failed for ${row.id}`, error);
    }
  }

  private async reloadIndex(): Promise<void> {
    try {
      const rows = await this.prisma.conditionalOrder.findMany({ where: { status: "WAITING" } });
      const next = new Map<string, Map<string, WaitingRow>>();
      for (const row of rows) {
        let bucket = next.get(row.symbol);
        if (!bucket) {
          bucket = new Map();
          next.set(row.symbol, bucket);
        }
        bucket.set(row.id, toWaiting(row));
      }
      // 발동 진행 중(이미 인덱스에서 뺀) 행은 DB claim이 막으므로 다시 넣어도 안전하다.
      this.waiting.clear();
      for (const [symbol, bucket] of next) this.waiting.set(symbol, bucket);
    } catch (error) {
      console.error("[conditional] index reload failed", error);
    }
  }

  private async evaluateAgainstLastPrices(): Promise<void> {
    const symbols = [...this.waiting.keys()].filter((symbol) => (this.waiting.get(symbol)?.size ?? 0) > 0);
    if (symbols.length === 0) return;
    try {
      const prices = await this.prisma.marketSymbol.findMany({ where: { symbol: { in: symbols } } });
      for (const { symbol, lastPrice } of prices) this.onTick(symbol, lastPrice);
    } catch (error) {
      console.error("[conditional] last price evaluation failed", error);
    }
  }

  private index(row: { id: string; symbol: string } & Parameters<typeof toWaiting>[0]): void {
    let bucket = this.waiting.get(row.symbol);
    if (!bucket) {
      bucket = new Map();
      this.waiting.set(row.symbol, bucket);
    }
    bucket.set(row.id, toWaiting(row));
  }

  private symbolFromTradeChannel(channel: string): string | null {
    const prefix = CHANNELS.trades("");
    if (!channel.startsWith(prefix)) return null;
    const symbol = channel.slice(prefix.length);
    return ACTIVE_SYMBOLS.has(symbol) ? symbol : null;
  }
}

function toWaiting(row: {
  id: string;
  accountId: string;
  symbol: string;
  side: string;
  direction: string;
  triggerPrice: number;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  ocoGroupId: string | null;
  trailBps: number | null;
  watermark: number | null;
}): WaitingRow {
  return {
    id: row.id,
    accountId: row.accountId,
    symbol: row.symbol,
    side: row.side as OrderSide,
    direction: row.direction as TriggerDirection,
    triggerPrice: row.triggerPrice,
    qty: row.qty,
    orderType: row.orderType as OrderType,
    limitPrice: row.limitPrice,
    ocoGroupId: row.ocoGroupId,
    trailBps: row.trailBps,
    watermark: row.watermark,
  };
}

function toDto(row: {
  id: string;
  symbol: string;
  side: string;
  direction: string;
  triggerPrice: number;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  ocoGroupId: string | null;
  trailBps: number | null;
  watermark: number | null;
  status: string;
  triggeredOrderId: string | null;
  triggerTradePrice: number | null;
  failReason: string | null;
  triggeredAt: Date | null;
  createdAt: Date;
}): ConditionalOrderDto {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side as OrderSide,
    direction: row.direction as TriggerDirection,
    triggerPrice: row.triggerPrice,
    qty: row.qty,
    orderType: row.orderType as OrderType,
    limitPrice: row.limitPrice,
    ocoGroupId: row.ocoGroupId,
    trailBps: row.trailBps,
    watermark: row.watermark,
    status: row.status as ConditionalOrderDto["status"],
    triggeredOrderId: row.triggeredOrderId,
    triggerTradePrice: row.triggerTradePrice,
    failReason: row.failReason,
    triggeredAt: row.triggeredAt ? row.triggeredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
