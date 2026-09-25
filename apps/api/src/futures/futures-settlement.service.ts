import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import type { PrismaClient } from "@mock-kabu/db";
import {
  applyFutureFill,
  applyFuturesCash,
  CHANNELS,
  FUTURES,
  futuresSettlementDue,
  futuresTradingDay,
  indexLevel,
  nextFuturesSettlementAt,
  type FutureDef,
  type OrderCancelRequestedEvent,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { BackgroundStatusRegistry } from "../core/background-status";
import { BALANCE_MUTATOR, PRISMA, REDIS } from "../core/tokens";
import { OutboxRelayer } from "../order/outbox.relayer";

/** 여러 API 인스턴스·재시작이 같은 거래일을 두 번 돌리지 않게 잡는 잠금 (정산은 이것과 별개로 멱등). */
const LOCK_TTL_SECONDS = 15 * 60;

export interface FuturesSettlementResult {
  tradingDay: string;
  canceledOrders: number;
  symbols: { symbol: string; price: number | null; positions: number; realizedTotal: bigint }[];
}

/**
 * 1일물 선물 일일 정산 (설계 §7). 매일 04:11 KST:
 *  1) 선물 미체결 주문 취소 요청 — 증거금은 엔진의 order.closed가 정산 컨슈머에서 풀어 준다.
 *  2) 최종 결제가격 = 그 시각 기초자산(KABU 지수는 현물 최근가, 나머지는 DB에 저장된 최신 1분봉 종가).
 *  3) 포지션마다 결제가격으로 전량 청산해 현금 정산(모자라면 미수금), 포지션 0.
 * 계좌·종목·거래일마다 processed_events claim을 남겨, 중간에 멈춘 정산도 다시 돌리면 남은 것만 처리한다.
 */
@Injectable()
export class FuturesSettlementService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastRun: { tradingDay: string; at: string; error: string | null } | null = null;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    @Inject(REDIS) private redis: Redis,
    @Optional() private outboxRelayer?: OutboxRelayer,
    @Optional() private background?: BackgroundStatusRegistry,
  ) {}

  onModuleInit() {
    this.background?.register("futuresSettlement", () => ({ status: "up", lastRun: this.lastRun }));
    // 배포·재기동으로 오늘 정산 시각을 놓쳤으면 바로 따라잡는다(이미 끝났으면 멱등이라 아무것도 안 한다).
    if (futuresSettlementDue(Date.now())) void this.runScheduled();
    this.scheduleNext();
  }

  onModuleDestroy() {
    this.stopped = true;
    this.background?.unregister("futuresSettlement");
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext() {
    if (this.stopped) return;
    const delay = Math.max(1_000, nextFuturesSettlementAt(Date.now()) - Date.now());
    this.timer = setTimeout(() => {
      void this.runScheduled().finally(() => this.scheduleNext());
    }, delay);
  }

  private async runScheduled(): Promise<void> {
    const tradingDay = futuresTradingDay(Date.now());
    const lockKey = `mock-kabu2:lock:futures-settle:${tradingDay}`;
    const locked = await this.redis.set(lockKey, randomUUID(), "EX", LOCK_TTL_SECONDS, "NX").catch(() => null);
    if (locked !== "OK") return;
    try {
      const result = await this.settle(tradingDay);
      const settled = result.symbols.reduce((sum, s) => sum + s.positions, 0);
      if (settled > 0 || result.canceledOrders > 0) {
        console.log(`[futures] ${tradingDay} settled ${settled} positions, canceled ${result.canceledOrders} orders`);
      }
      this.lastRun = { tradingDay, at: new Date().toISOString(), error: null };
    } catch (error) {
      console.error("[futures] daily settlement failed", error);
      this.lastRun = { tradingDay, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      // 잠금을 풀어 다음 재시도(재기동·수동 실행)가 막히지 않게 한다.
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /** 한 거래일을 정산한다. 여러 번 불러도 결과가 같다(이미 정산한 계좌·종목은 건너뛴다). */
  async settle(tradingDay: string): Promise<FuturesSettlementResult> {
    const canceledOrders = await this.cancelOpenFuturesOrders();
    const prices = await this.settlementPrices();
    const symbols: FuturesSettlementResult["symbols"] = [];

    for (const def of FUTURES) {
      // 이 거래일에 이미 정산을 마친 종목은 건너뛴다. 정산 뒤(04:20~) 새로 연 포지션은 다음 거래일 몫이라,
      // 낮에 API가 재시작돼 따라잡기가 다시 돌아도 그 포지션을 닫으면 안 된다.
      const done = await this.prisma.futuresSettlement.findUnique({
        where: { symbol_tradingDay: { symbol: def.symbol, tradingDay } },
      });
      if (done) {
        symbols.push({ symbol: def.symbol, price: done.price, positions: 0, realizedTotal: 0n });
        continue;
      }
      const price = prices.get(def.symbol) ?? null;
      const open = await this.prisma.futuresPosition.findMany({ where: { symbol: def.symbol, qty: { not: 0 } } });
      if (price == null) {
        // 기초자산 가격이 없으면 정산하지 않는다(다음 실행에 다시 시도). 포지션을 잘못된 값으로 닫지 않는다.
        if (open.length > 0) throw new Error(`no settlement price for ${def.symbol}`);
        symbols.push({ symbol: def.symbol, price: null, positions: 0, realizedTotal: 0n });
        continue;
      }
      let positions = 0;
      let realizedTotal = 0n;
      for (const position of open) {
        const realized = await this.settlePosition(def, tradingDay, price, position.accountId);
        if (realized != null) {
          positions += 1;
          realizedTotal += realized;
        }
      }
      // 종목의 포지션을 모두 정산한 뒤에만 완료 기록을 남긴다(중간에 멈추면 기록이 없어 다음 실행이 이어서 한다).
      await this.prisma.futuresSettlement.create({
        data: { symbol: def.symbol, tradingDay, price, positions, realizedTotal },
      });
      symbols.push({ symbol: def.symbol, price, positions, realizedTotal });
    }
    return { tradingDay, canceledOrders, symbols };
  }

  /** 한 계좌의 한 종목 포지션을 결제가격으로 닫는다. 이미 이 거래일에 정산했으면 null. */
  private async settlePosition(def: FutureDef, tradingDay: string, price: number, accountId: string): Promise<bigint | null> {
    const eventId = `futures-settle:${def.symbol}:${tradingDay}:${accountId}`;
    let realizedOut: bigint | null = null;
    await this.mutator.withAccountLock([accountId], async (ctx) => {
      const claimed = await ctx.tx.processedEvent.findUnique({ where: { eventId } });
      if (claimed) return;
      await ctx.tx.processedEvent.create({ data: { eventId } });

      const where = { accountId_symbol: { accountId, symbol: def.symbol } };
      const position = await ctx.tx.futuresPosition.findUnique({ where });
      if (!position || position.qty === 0) return;
      const closeSide = position.qty > 0 ? "SELL" : "BUY";
      const fill = applyFutureFill(def, { qty: position.qty, entryValue: position.entryValue }, closeSide, price, Math.abs(position.qty));
      await ctx.tx.futuresPosition.update({ where, data: { qty: 0, entryValue: 0n, marginHeld: 0n } });
      await ctx.tx.futuresRealized.create({
        data: { accountId, symbol: def.symbol, tradeId: eventId, side: "SETTLE", closedQty: fill.closedQty, price, realized: fill.realized },
      });

      const account = ctx.accounts[accountId];
      const debtRow = await ctx.tx.futuresDebt.findUnique({ where: { accountId } });
      const cash = applyFuturesCash({ balance: account.balance, holdAmount: account.holdAmount, debt: debtRow?.amount ?? 0n }, fill.realized);
      await ctx.updateAccount(accountId, { balance: cash.balance, holdAmount: account.holdAmount });
      if (cash.ledgerDelta !== 0n) {
        await ctx.tx.ledgerEntry.create({
          data: { accountId, delta: cash.ledgerDelta, balanceAfter: cash.balance, reason: "FUTURES_SETTLE", refId: eventId },
        });
      }
      if (cash.debt !== (debtRow?.amount ?? 0n)) {
        await ctx.tx.futuresDebt.upsert({ where: { accountId }, update: { amount: cash.debt }, create: { accountId, amount: cash.debt } });
      }
      realizedOut = fill.realized;
    });
    if (realizedOut != null) {
      this.redis
        .publish(CHANNELS.account(accountId), JSON.stringify({ type: "futures_settled", symbol: def.symbol, tradingDay }))
        .catch(() => undefined);
    }
    return realizedOut;
  }

  /** 선물 미체결 주문 전부 취소 요청(점검 중이라 새 주문은 없다). 이미 요청된 것도 엔진이 멱등하게 처리한다. */
  private async cancelOpenFuturesOrders(): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: { symbol: { in: FUTURES.map((f) => f.symbol) }, status: { in: ["OPEN", "PARTIAL"] } },
      select: { id: true, symbol: true },
    });
    if (orders.length === 0) return 0;
    await this.prisma.outbox.createMany({
      data: orders.map((order) => {
        const event: OrderCancelRequestedEvent = {
          topic: "order.cancel.requested",
          eventId: randomUUID(),
          orderId: order.id,
          symbol: order.symbol,
          ts: Date.now(),
        };
        return { eventId: event.eventId, topic: event.topic, payload: event as object };
      }),
    });
    this.outboxRelayer?.flushSoon();
    return orders.length;
  }

  /** 최종 결제가격(선물과 같은 정수 단위). KABU 지수는 현물 최근가로, 나머지는 DB의 최신 기초자산 1분봉 종가. */
  async settlementPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const [epoch, stocks, references] = await Promise.all([
      this.prisma.indexEpoch.findFirst({ orderBy: { startsAt: "desc" } }),
      this.prisma.marketSymbol.findMany({ where: { kind: "STOCK" }, select: { symbol: true, lastPrice: true, listedShares: true } }),
      this.prisma.$queryRaw<{ code: string; close: number }[]>`
        SELECT DISTINCT ON (code) code, close FROM market.reference_candles
        WHERE interval = '1m' ORDER BY code, ts DESC
      `,
    ]);
    const referenceClose = new Map(references.map((row) => [row.code, Number(row.close)]));
    for (const def of FUTURES) {
      if (def.underlying === "KABU_INDEX") {
        if (!epoch || epoch.divisor <= 0) continue;
        const price = new Map(stocks.map((s) => [s.symbol, s.lastPrice]));
        const shares = new Map(stocks.map((s) => [s.symbol, Number(s.listedShares)]));
        const level = indexLevel(epoch, (symbol) => price.get(symbol) ?? 0, (symbol) => shares.get(symbol) ?? 0);
        if (Number.isFinite(level) && level > 0) prices.set(def.symbol, Math.round(level * def.priceScale));
      } else {
        // 기초자산 저장값의 scale이 선물 priceScale과 같다(원/달러 10, 원자재 100).
        const close = referenceClose.get(def.underlying);
        if (close != null && close > 0) prices.set(def.symbol, close);
      }
    }
    return prices;
  }
}
