import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  assessFuturesRisk,
  CHANNELS,
  FUTURES,
  FUTURES_MARGIN_CALL_GRACE_MS,
  futureDef,
  futuresPositionKey,
  MARKET_BUY_HOLD_FACTOR,
  marginCallLiquidationQty,
  rowSideOf,
  type FuturesPositionRowSide,
  type FuturesRiskPosition,
  type OrderCancelRequestedEvent,
  type OrderPlacedEvent,
  type OrderSide,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { maintenanceWindow } from "../common/maintenance-window";
import { BackgroundStatusRegistry } from "../core/background-status";
import { PRISMA, REDIS } from "../core/tokens";
import { OutboxRelayer } from "../order/outbox.relayer";
import { FuturesService } from "./futures.service";

const TICK_MS = 5_000;
/** 여러 API 인스턴스가 같은 틱을 두 번 돌리지 않게 — 틱 간격보다 짧게 잡는다. */
const LOCK_KEY = "mock-kabu2:lock:futures-risk";
const LOCK_TTL_SECONDS = 4;
const LIVE = ["OPEN", "PARTIAL"];

export type LiquidationReason = "DEADLINE" | "EMERGENCY";

export interface FuturesRiskTickResult {
  accounts: number;
  calls: number;
  resolved: number;
  liquidations: number;
}

/**
 * 선물 추가증거금·반대매매 (설계 §6). 5초마다 포지션이 있는 계좌를 평가한다.
 *  - 평가예탁금(현금 + 평가손익 − 미수금) < 유지증거금 → 추가증거금 발생, 30분 유예.
 *  - 위탁증거금 수준까지 회복(입금·가격 회복·청산) → 해소.
 *  - 기한까지 못 채우면 추가증거금 ÷ 위탁증거금 비율만큼 포지션마다 시장가 반대매매.
 *  - 한 포지션의 평가손실이 그 위탁증거금의 90%에 닿으면 기한과 상관없이 그 포지션 전량 반대매매.
 * 반대매매 주문은 증거금을 묶지 않는(holdPerUnit 0) 시장가로 내고, 최근가 ±10%를 보호 한도로 준다.
 * 점검 시간(04:10~04:20)에는 돌지 않는다 — 그때는 일일 정산이 포지션을 모두 닫는다.
 */
@Injectable()
export class FuturesRiskService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTick: { at: string; result: FuturesRiskTickResult | null; error: string | null } | null = null;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    private futures: FuturesService,
    @Optional() private outboxRelayer?: OutboxRelayer,
    @Optional() private background?: BackgroundStatusRegistry,
  ) {}

  onModuleInit() {
    if (process.env.FUTURES_RISK_DISABLED === "1") return;
    this.background?.register("futuresRisk", () => ({ status: "up", lastTick: this.lastTick }));
    this.timer = setInterval(() => void this.runScheduled(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.background?.unregister("futuresRisk");
  }

  private async runScheduled() {
    if (this.running) return;
    this.running = true;
    try {
      const locked = await this.redis.set(LOCK_KEY, randomUUID(), "EX", LOCK_TTL_SECONDS, "NX").catch(() => null);
      if (locked !== "OK") return;
      const result = await this.tick();
      this.lastTick = { at: new Date().toISOString(), result, error: null };
    } catch (error) {
      console.error("[futures] risk tick failed", error);
      this.lastTick = { at: new Date().toISOString(), result: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.running = false;
    }
  }

  /** 한 번 평가한다. 테스트·수동 점검용으로 now를 받는다. */
  async tick(now = Date.now()): Promise<FuturesRiskTickResult> {
    const result: FuturesRiskTickResult = { accounts: 0, calls: 0, resolved: 0, liquidations: 0 };
    if (maintenanceWindow(now).active) return result;

    const [positions, activeCalls, marks] = await Promise.all([
      this.prisma.futuresPosition.findMany({ where: { qty: { not: 0 } } }),
      this.prisma.futuresMarginCall.findMany({ where: { resolvedAt: null } }),
      // 평가가격 = 기초자산·최근 체결 중앙값·최근가의 중앙값 — 튀는 체결 하나로 청산되지 않게
      this.futures.marks(),
    ]);
    const accountIds = [...new Set([...positions.map((p) => p.accountId), ...activeCalls.map((c) => c.accountId)])];
    if (accountIds.length === 0) return result;

    const [accounts, debts, pending] = await Promise.all([
      this.prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, balance: true } }),
      this.prisma.futuresDebt.findMany({ where: { accountId: { in: accountIds } } }),
      this.pendingLiquidationAccounts(),
    ]);
    const markBySymbol = marks;
    const balanceById = new Map(accounts.map((a) => [a.id, a.balance]));
    const debtById = new Map(debts.map((d) => [d.accountId, d.amount]));
    const callById = new Map(activeCalls.map((c) => [c.accountId, c]));

    for (const accountId of accountIds) {
      result.accounts += 1;
      // 앞서 낸 반대매매가 아직 체결·정산 중이면 그 결과를 본 뒤에 다시 판단한다(이중 반대매매 방지).
      if (pending.has(accountId)) continue;
      const call = callById.get(accountId) ?? null;
      const riskPositions: FuturesRiskPosition[] = positions
        .filter((p) => p.accountId === accountId)
        .flatMap((p) => {
          const def = futureDef(p.symbol);
          const mark = markBySymbol.get(p.symbol) ?? def?.initialPrice;
          return def && mark
            ? [{ def, qty: p.qty, entryValue: p.entryValue, marginHeld: p.marginHeld, mark, leverage: p.leverage, positionSide: rowSideOf(p.positionSide) }]
            : [];
        });

      if (riskPositions.length === 0) {
        if (call) {
          await this.closeCall(call.id, "RESOLVED", now);
          this.notify(accountId, { type: "futures_margin_call", status: "RESOLVED" });
          result.resolved += 1;
        }
        continue;
      }

      const risk = assessFuturesRisk(riskPositions, {
        balance: balanceById.get(accountId) ?? 0n,
        debt: debtById.get(accountId) ?? 0n,
      });

      if (risk.emergency.length > 0) {
        const callId = call?.id ?? (await this.openCall(accountId, risk.shortfall, now, "EMERGENCY"));
        if (call) await this.closeCall(call.id, "EMERGENCY", now);
        const targets = riskPositions
          .filter((p) => risk.emergency.includes(futuresPositionKey(p.def.symbol, p.positionSide ?? "NET")))
          .map((p) => ({ symbol: p.def.symbol, qty: p.qty, mark: p.mark, positionSide: p.positionSide ?? "NET" }));
        result.liquidations += await this.liquidate(accountId, targets, "EMERGENCY", callId);
        this.notify(accountId, { type: "futures_margin_call", status: "EMERGENCY", symbols: risk.emergency });
        continue;
      }

      if (call) {
        if (risk.shortfall === 0n) {
          await this.closeCall(call.id, "RESOLVED", now);
          this.notify(accountId, { type: "futures_margin_call", status: "RESOLVED" });
          result.resolved += 1;
        } else if (now >= call.deadline.getTime()) {
          const targets = riskPositions
            .map((p) => ({
              symbol: p.def.symbol,
              qty: p.qty,
              mark: p.mark,
              positionSide: p.positionSide ?? "NET",
              close: marginCallLiquidationQty(p.qty, risk.shortfall, risk.initial),
            }))
            .filter((p) => p.close > 0)
            .map((p) => ({ symbol: p.symbol, qty: Math.sign(p.qty) * p.close, mark: p.mark, positionSide: p.positionSide }));
          await this.closeCall(call.id, "LIQUIDATED", now);
          result.liquidations += await this.liquidate(accountId, targets, "DEADLINE", call.id);
          this.notify(accountId, { type: "futures_margin_call", status: "LIQUIDATED" });
        }
        continue;
      }

      if (risk.belowMaintenance) {
        await this.openCall(accountId, risk.shortfall, now, null);
        this.notify(accountId, {
          type: "futures_margin_call",
          status: "OPEN",
          required: String(risk.shortfall),
          deadline: new Date(now + FUTURES_MARGIN_CALL_GRACE_MS).toISOString(),
        });
        result.calls += 1;
      }
    }
    return result;
  }

  /**
   * 반대매매 주문이 아직 살아 있는 계좌. 반대매매·청산 주문은 모두 증거금 0이라, 살아 있는 증거금 0 선물 주문 중
   * 반대매매 기록(futures_liquidations)에 있는 것만 센다 — 사용자의 청산 지정가가 감시를 막지 않게.
   */
  private async pendingLiquidationAccounts(): Promise<Set<string>> {
    const live = await this.prisma.order.findMany({
      where: { symbol: { in: FUTURES.map((f) => f.symbol) }, status: { in: LIVE }, holdPerUnit: 0n },
      select: { id: true },
    });
    if (live.length === 0) return new Set();
    const rows = await this.prisma.futuresLiquidation.findMany({
      where: { orderId: { in: live.map((order) => order.id) } },
      select: { accountId: true },
    });
    return new Set(rows.map((row) => row.accountId));
  }

  /** 추가증거금 기록을 연다. outcome을 주면(긴급 반대매매) 바로 닫힌 기록으로 남긴다. */
  private async openCall(accountId: string, required: bigint, now: number, outcome: "EMERGENCY" | null): Promise<string> {
    const row = await this.prisma.futuresMarginCall.create({
      data: {
        accountId,
        startedAt: new Date(now),
        deadline: new Date(outcome ? now : now + FUTURES_MARGIN_CALL_GRACE_MS),
        required,
        ...(outcome ? { resolvedAt: new Date(now), outcome } : {}),
      },
    });
    return row.id;
  }

  private async closeCall(id: string, outcome: string, now: number) {
    await this.prisma.futuresMarginCall.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: new Date(now), outcome },
    });
  }

  /**
   * 계좌의 선물 미체결 주문을 모두 취소 요청하고, 각 대상 포지션의 반대 방향 시장가를 낸다.
   * qty는 줄일 포지션 부호 그대로(롱 +n → SELL n). 양방향 행은 그 방향(positionSide)의 청산 주문으로 낸다.
   * 낸 주문 수를 돌려준다.
   */
  private async liquidate(
    accountId: string,
    targets: { symbol: string; qty: number; mark: number; positionSide: FuturesPositionRowSide }[],
    reason: LiquidationReason,
    marginCallId: string,
  ): Promise<number> {
    const orders = targets.filter((t) => t.qty !== 0);
    if (orders.length === 0) return 0;
    const open = await this.prisma.order.findMany({
      where: { accountId, symbol: { in: FUTURES.map((f) => f.symbol) }, status: { in: LIVE } },
      select: { id: true, symbol: true },
    });
    await this.prisma.$transaction(async (tx) => {
      for (const order of open) {
        const event: OrderCancelRequestedEvent = {
          topic: "order.cancel.requested",
          eventId: randomUUID(),
          orderId: order.id,
          symbol: order.symbol,
          ts: Date.now(),
        };
        await tx.outbox.create({ data: { eventId: event.eventId, topic: event.topic, payload: event as object } });
      }
      for (const target of orders) {
        const side: OrderSide = target.qty > 0 ? "SELL" : "BUY";
        const qty = Math.abs(target.qty);
        // 호가가 비어도 터무니없는 값에 체결되지 않게 최근가 ±10%를 보호 한도로 둔다. 남은 수량은 IOC로 취소되고
        // 다음 틱이 다시 판단한다.
        const bound =
          side === "BUY" ? Math.ceil(target.mark * MARKET_BUY_HOLD_FACTOR) : Math.max(1, Math.floor(target.mark / MARKET_BUY_HOLD_FACTOR));
        const order = await tx.order.create({
          data: {
            accountId,
            symbol: target.symbol,
            side,
            type: "MARKET",
            price: null,
            qty,
            holdPerUnit: 0n,
            // 양방향 행은 그 방향의 청산 주문으로(롱 행 +는 SELL, 숏 행 −는 BUY). 순포지션은 방향 없음.
            positionSide: target.positionSide === "NET" ? null : target.positionSide,
          },
        });
        await tx.futuresLiquidation.create({
          data: { orderId: order.id, accountId, symbol: target.symbol, side, qty, reason, marginCallId },
        });
        const event: OrderPlacedEvent = {
          topic: "order.placed",
          eventId: randomUUID(),
          orderId: order.id,
          accountId,
          symbol: target.symbol,
          side,
          type: "MARKET",
          price: bound,
          qty,
          ts: Date.now(),
        };
        await tx.outbox.create({ data: { eventId: event.eventId, topic: event.topic, payload: event as object } });
      }
    });
    this.outboxRelayer?.flushSoon();
    console.log(
      `[futures] ${reason} liquidation ${accountId}: ${orders.map((t) => `${t.symbol} ${t.qty > 0 ? "SELL" : "BUY"} ${Math.abs(t.qty)}`).join(", ")}`,
    );
    return orders.length;
  }

  private notify(accountId: string, payload: Record<string, unknown>) {
    this.redis.publish(CHANNELS.account(accountId), JSON.stringify(payload)).catch(() => undefined);
  }
}
