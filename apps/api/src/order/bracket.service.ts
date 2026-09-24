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
import { TRAIL_BPS_MAX, TRAIL_BPS_MIN, conditionMet, type BracketIntentDto } from "@mock-kabu/shared";
import { BackgroundStatusRegistry } from "../core/background-status";
import { maintenanceWindow } from "../common/maintenance-window";
import { PRISMA } from "../core/tokens";
import { RealtimeGateway } from "../gateway/realtime.gateway";
import { ConditionalOrderService } from "./conditional-order.service";
import { OrderService } from "./order.service";

export interface BracketSpec {
  /** 손절 거리 bps (체결 평균가 아래) */
  stopBps: number;
  /** 익절 거리 bps (체결 평균가 위) */
  takeBps: number;
}

const POLL_MS = 3_000;
const TAKE_BPS_MAX = 10_000;
const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED"]);

/**
 * "체결 후 손절/익절 자동 등록". 매수 주문에 붙은 의도를 3초마다 훑어, 부모 주문이 종결되면
 * 체결 평균가 기준 OCO를 만든다. 주문이 부분 체결로 끝나면 체결된 수량만큼만 보호하고,
 * 아무것도 체결되지 않았으면 조용히 닫는다. 체결 사이에 가격이 이미 손절/익절선을 넘어가
 * 있으면 OCO 대신 즉시 시장가 매도를 낸다 — 실제 증권사의 즉시 발동과 같은 처리다.
 */
@Injectable()
export class BracketService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private armedCount = 0;
  private lastSweepAt: number | null = null;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    private conditional: ConditionalOrderService,
    private orders: OrderService,
    private realtime: RealtimeGateway,
    @Optional() private background?: BackgroundStatusRegistry,
  ) {}

  onModuleInit() {
    this.background?.register("bracketIntents", () => ({
      status: "up",
      armed: this.armedCount,
      lastSweepAt: this.lastSweepAt ? new Date(this.lastSweepAt).toISOString() : null,
    }));
    this.timer = setInterval(() => void this.sweep(), POLL_MS);
    void this.sweep();
  }

  onModuleDestroy() {
    this.background?.unregister("bracketIntents");
    if (this.timer) clearInterval(this.timer);
  }

  static validateSpec(spec: BracketSpec): BracketSpec {
    const stopBps = Number(spec.stopBps);
    const takeBps = Number(spec.takeBps);
    if (!Number.isInteger(stopBps) || stopBps < TRAIL_BPS_MIN || stopBps > TRAIL_BPS_MAX) {
      throw new BadRequestException(`손절 거리는 ${TRAIL_BPS_MIN / 100}%~${TRAIL_BPS_MAX / 100}% 사이여야 합니다`);
    }
    if (!Number.isInteger(takeBps) || takeBps < TRAIL_BPS_MIN || takeBps > TAKE_BPS_MAX) {
      throw new BadRequestException(`익절 거리는 ${TRAIL_BPS_MIN / 100}%~${TAKE_BPS_MAX / 100}% 사이여야 합니다`);
    }
    return { stopBps, takeBps };
  }

  /** 매수 주문 접수 직후 호출. 주문 자체는 이미 커밋됐으므로 여기서 실패해도 주문은 유효하다. */
  async attach(accountId: string, orderId: string, symbol: string, spec: BracketSpec): Promise<BracketIntentDto> {
    const valid = BracketService.validateSpec(spec);
    const row = await this.prisma.bracketIntent.create({
      data: { accountId, orderId, symbol, stopBps: valid.stopBps, takeBps: valid.takeBps },
    });
    return toDto(row);
  }

  async list(accountId: string, symbol?: string, limit = 50): Promise<BracketIntentDto[]> {
    const rows = await this.prisma.bracketIntent.findMany({
      where: { accountId, ...(symbol ? { symbol } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(1, limit), 200),
    });
    return rows.map(toDto);
  }

  async cancel(accountId: string, id: string): Promise<BracketIntentDto> {
    const existing = await this.prisma.bracketIntent.findUnique({ where: { id } });
    if (!existing || existing.accountId !== accountId) throw new NotFoundException("자동 보호 설정을 찾을 수 없습니다");
    if (existing.status !== "PENDING") throw new BadRequestException("이미 등록됐거나 취소된 설정입니다");
    const claimed = await this.prisma.bracketIntent.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CANCELED", note: "사용자 취소" },
    });
    if (claimed.count === 0) throw new BadRequestException("이미 처리된 설정입니다");
    const row = await this.prisma.bracketIntent.findUniqueOrThrow({ where: { id } });
    this.realtime.notifyAccount(accountId, { type: "bracket", id, status: row.status });
    return toDto(row);
  }

  async sweep(): Promise<void> {
    if (maintenanceWindow().active) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const pending = await this.prisma.bracketIntent.findMany({ where: { status: "PENDING" } });
      for (const intent of pending) await this.settle(intent.id);
      this.lastSweepAt = Date.now();
    } catch (error) {
      console.error("[bracket] sweep failed", error);
    } finally {
      this.sweeping = false;
    }
  }

  private async settle(intentId: string): Promise<void> {
    const intent = await this.prisma.bracketIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.status !== "PENDING") return;
    const order = await this.prisma.order.findUnique({ where: { id: intent.orderId } });
    if (!order || !TERMINAL.has(order.status)) return;

    // 다른 인스턴스가 먼저 처리했으면 count 0. 결과는 아래에서 채운다.
    const claimed = await this.prisma.bracketIntent.updateMany({
      where: { id: intent.id, status: "PENDING" },
      data: { status: "ARMED" },
    });
    if (claimed.count === 0) return;

    try {
      if (order.filledQty <= 0) {
        await this.prisma.bracketIntent.update({
          where: { id: intent.id },
          data: { status: "CANCELED", note: "체결 없이 종결된 주문" },
        });
        this.realtime.notifyAccount(intent.accountId, { type: "bracket", id: intent.id, status: "CANCELED" });
        return;
      }

      const [fill] = await this.prisma.$queryRaw<{ qty: bigint; amount: bigint }[]>`
        SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(price::bigint * qty), 0) AS amount
        FROM matching.trades WHERE buy_order_id = ${order.id}
      `;
      const filledQty = Number(fill?.qty ?? 0n) || order.filledQty;
      const avgFillPrice = filledQty > 0 ? Math.round(Number(fill.amount) / filledQty) : order.price ?? 0;
      const lowerPrice = Math.max(1, Math.floor(avgFillPrice * (1 - intent.stopBps / 10_000)));
      const upperPrice = Math.max(lowerPrice + 1, Math.ceil(avgFillPrice * (1 + intent.takeBps / 10_000)));

      const market = await this.prisma.marketSymbol.findUniqueOrThrow({ where: { symbol: intent.symbol } });
      let note: string;
      if (conditionMet("AT_OR_BELOW", lowerPrice, market.lastPrice) || conditionMet("AT_OR_ABOVE", upperPrice, market.lastPrice)) {
        // 체결과 등록 사이에 이미 선을 넘었다 — 예약 대신 즉시 시장가로 정리한다.
        const reason = market.lastPrice <= lowerPrice ? "손절선 이미 도달" : "익절선 이미 도달";
        try {
          const sell = await this.orders.place(intent.accountId, {
            symbol: intent.symbol,
            side: "SELL",
            type: "MARKET",
            qty: filledQty,
          });
          note = `${reason} → 즉시 시장가 매도 (${sell.id})`;
        } catch (error) {
          note = `${reason}, 즉시 매도 실패: ${error instanceof HttpException ? error.message : "주문 접수 실패"}`;
        }
      } else {
        const legs = await this.conditional.placeOco(intent.accountId, {
          symbol: intent.symbol,
          side: "SELL",
          qty: filledQty,
          lowerPrice,
          upperPrice,
        });
        note = `OCO 등록 손절 ${lowerPrice.toLocaleString("ko-KR")} / 익절 ${upperPrice.toLocaleString("ko-KR")} (${legs[0].ocoGroupId})`;
      }

      await this.prisma.bracketIntent.update({
        where: { id: intent.id },
        data: { armedQty: filledQty, avgFillPrice, note },
      });
      this.armedCount += 1;
      this.realtime.notifyAccount(intent.accountId, {
        type: "bracket",
        id: intent.id,
        status: "ARMED",
        symbol: intent.symbol,
        qty: filledQty,
        avgFillPrice,
        lowerPrice,
        upperPrice,
        note,
      });
    } catch (error) {
      // 등록 자체가 실패하면 되돌려 다음 sweep이 다시 시도하게 한다. 사유는 note에 남긴다.
      const message = error instanceof HttpException ? error.message : error instanceof Error ? error.message : String(error);
      console.error(`[bracket] arming failed for ${intent.id}: ${message}`);
      await this.prisma.bracketIntent
        .update({ where: { id: intent.id }, data: { status: "PENDING", note: `등록 재시도 대기: ${message}` } })
        .catch(() => {});
    }
  }
}

function toDto(row: {
  id: string;
  orderId: string;
  symbol: string;
  stopBps: number;
  takeBps: number;
  status: string;
  armedQty: number;
  avgFillPrice: number | null;
  note: string | null;
  createdAt: Date;
}): BracketIntentDto {
  return {
    id: row.id,
    orderId: row.orderId,
    symbol: row.symbol,
    stopBps: row.stopBps,
    takeBps: row.takeBps,
    status: row.status as BracketIntentDto["status"],
    armedQty: row.armedQty,
    avgFillPrice: row.avgFillPrice,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
