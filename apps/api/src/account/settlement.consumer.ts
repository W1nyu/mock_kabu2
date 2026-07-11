import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import type { PrismaClient } from "@mock-kabu/db";
import {
  CONSUMER_GROUPS,
  STREAMS,
  type OrderClosedEvent,
  type TradeExecutedEvent,
  type TradeStreamEvent,
} from "@mock-kabu/shared";
import Redis from "ioredis";
import { BALANCE_MUTATOR, PRISMA } from "../core/tokens";
import { RealtimeGateway } from "../gateway/realtime.gateway";

type StreamReply = [key: string, messages: [id: string, fields: string[]][]][] | null;

/**
 * 체결 정산 컨슈머 (스펙 3.2의 4단계).
 * trade.executed → 매수자/매도자 잔액·보유자산 갱신(락 전략 적용) + 홀드 소진
 * order.closed   → 주문 종결 + 잔여 홀드 해제
 * 멱등성: processed_events(event_id PK)로 중복 소비 무시.
 */
@Injectable()
export class SettlementConsumer implements OnModuleInit, OnModuleDestroy {
  /** 블로킹 XREADGROUP 전용 커넥션 (공용 커넥션을 막지 않도록 분리) */
  private stream: Redis;
  private running = true;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    private realtime: RealtimeGateway,
  ) {
    this.stream = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }

  async onModuleInit() {
    try {
      await this.stream.xgroup("CREATE", STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT, "0", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
    }
    void this.loop();
  }

  onModuleDestroy() {
    this.running = false;
    this.stream.disconnect();
  }

  private async loop() {
    const consumer = `settlement-${process.pid}`;
    // 크래시 전 미ack 메시지부터 처리 (멱등하므로 그대로 재처리)
    let cursor: string = "0";
    while (this.running) {
      let reply: StreamReply = null;
      try {
        reply = (await this.stream.xreadgroup(
          "GROUP", CONSUMER_GROUPS.SETTLEMENT, consumer,
          "COUNT", 100,
          "BLOCK", 5000,
          "STREAMS", STREAMS.TRADES, cursor,
        )) as StreamReply;
      } catch (e) {
        if (!this.running) return;
        console.error("[settlement] xreadgroup error, retrying", e);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const messages = reply?.[0]?.[1] ?? [];
      if (cursor === "0" && messages.length === 0) {
        cursor = ">"; // pending 소진 → 라이브 소비로 전환
        continue;
      }

      for (const [id, fields] of messages) {
        const idx = fields.indexOf("payload");
        if (idx >= 0) {
          const ev = JSON.parse(fields[idx + 1]) as TradeStreamEvent;
          try {
            if (ev.topic === "trade.executed") await this.settleTrade(ev);
            else if (ev.topic === "order.closed") await this.closeOrder(ev);
          } catch (e) {
            // 멱등 테이블이 있으므로 로그 후 ack (poison 방지)
            console.error(`[settlement] event failed (ack & skip) ${ev.eventId}`, e);
          }
        }
        await this.stream.xack(STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT, id);
      }
    }
  }

  private async settleTrade(ev: TradeExecutedEvent) {
    const cost = BigInt(ev.price) * BigInt(ev.qty);
    const parties = [...new Set([ev.buyerAccountId, ev.sellerAccountId])];

    const settled = await this.mutator.withAccountLock(parties, async (ctx) => {
      const dup = await ctx.tx.processedEvent.findUnique({ where: { eventId: ev.eventId } });
      if (dup) return false;
      await ctx.tx.processedEvent.create({ data: { eventId: ev.eventId } });

      const buyOrder = await ctx.tx.order.findUniqueOrThrow({ where: { id: ev.buyOrderId } });
      const sellOrder = await ctx.tx.order.findUniqueOrThrow({ where: { id: ev.sellOrderId } });
      const holdConsumed = buyOrder.holdPerUnit * BigInt(ev.qty);

      // 계좌별 순변화량 집계 (자전거래 시 같은 계좌가 양쪽일 수 있음)
      const deltas = new Map<string, { balance: bigint; hold: bigint }>();
      const add = (id: string, balance: bigint, hold: bigint) => {
        const d = deltas.get(id) ?? { balance: 0n, hold: 0n };
        d.balance += balance;
        d.hold += hold;
        deltas.set(id, d);
      };
      add(ev.buyerAccountId, -cost, -holdConsumed);
      add(ev.sellerAccountId, cost, 0n);

      for (const [accountId, d] of deltas) {
        const acc = ctx.accounts[accountId];
        await ctx.updateAccount(accountId, {
          balance: acc.balance + d.balance,
          holdAmount: acc.holdAmount + d.hold,
        });
      }

      // 원장 (복식부기): 매수자 -cost, 매도자 +cost
      const running = new Map<string, bigint>(
        parties.map((id) => [id, ctx.accounts[id].balance]),
      );
      const ledger = (accountId: string, delta: bigint, reason: string) => {
        const after = running.get(accountId)! + delta;
        running.set(accountId, after);
        return ctx.tx.ledgerEntry.create({
          data: { accountId, delta, balanceAfter: after, reason, refId: ev.tradeId },
        });
      };
      await ledger(ev.buyerAccountId, -cost, "TRADE_BUY");
      await ledger(ev.sellerAccountId, cost, "TRADE_SELL");

      // 보유자산: 매수자 +qty, 매도자 -qty(홀드분 소진)
      await ctx.tx.holding.upsert({
        where: { accountId_symbol: { accountId: ev.buyerAccountId, symbol: ev.symbol } },
        update: { qty: { increment: ev.qty } },
        create: { accountId: ev.buyerAccountId, symbol: ev.symbol, qty: ev.qty },
      });
      await ctx.tx.holding.update({
        where: { accountId_symbol: { accountId: ev.sellerAccountId, symbol: ev.symbol } },
        data: { qty: { decrement: ev.qty }, holdQty: { decrement: ev.qty } },
      });

      // 주문 진행 상태 갱신 (종결은 order.closed가 담당)
      for (const order of [buyOrder, sellOrder]) {
        const filled = order.filledQty + ev.qty;
        await ctx.tx.order.update({
          where: { id: order.id },
          data: {
            filledQty: filled,
            status: order.status === "OPEN" || order.status === "PARTIAL"
              ? (filled >= order.qty ? "FILLED" : "PARTIAL")
              : order.status,
          },
        });
      }
      return true;
    });

    if (!settled) return;

    // 락 밖: 시세/캔들 반영 + 실시간 알림
    await this.updateMarket(ev);
    this.realtime.notifyAccount(ev.buyerAccountId, { type: "account_update" });
    this.realtime.notifyAccount(ev.sellerAccountId, { type: "account_update" });
  }

  private async closeOrder(ev: OrderClosedEvent) {
    await this.mutator.withAccountLock([ev.accountId], async (ctx) => {
      const dup = await ctx.tx.processedEvent.findUnique({ where: { eventId: ev.eventId } });
      if (dup) return;
      await ctx.tx.processedEvent.create({ data: { eventId: ev.eventId } });

      const order = await ctx.tx.order.findUnique({ where: { id: ev.orderId } });
      if (!order) return;
      if (["CANCELED", "REJECTED"].includes(order.status)) return;

      await ctx.tx.order.update({
        where: { id: ev.orderId },
        data: { status: ev.status, filledQty: ev.filledQty },
      });

      const remainingQty = order.qty - ev.filledQty;
      if (remainingQty <= 0) return;

      if (ev.side === "BUY") {
        // 잔여 현금 홀드 해제
        const leftover = order.holdPerUnit * BigInt(remainingQty);
        if (leftover > 0n) {
          const acc = ctx.accounts[ev.accountId];
          await ctx.updateAccount(ev.accountId, {
            balance: acc.balance,
            holdAmount: acc.holdAmount - leftover,
          });
        }
      } else {
        // 잔여 수량 홀드 해제
        await ctx.tx.holding.update({
          where: { accountId_symbol: { accountId: ev.accountId, symbol: ev.symbol } },
          data: { holdQty: { decrement: remainingQty } },
        });
      }
    });

    this.realtime.notifyAccount(ev.accountId, { type: "account_update" });
  }

  private async updateMarket(ev: TradeExecutedEvent) {
    await this.prisma.marketSymbol.update({
      where: { symbol: ev.symbol },
      data: { lastPrice: ev.price },
    });

    const bucket = new Date(Math.floor(ev.ts / 60_000) * 60_000);
    const existing = await this.prisma.candle.findUnique({
      where: { symbol_interval_ts: { symbol: ev.symbol, interval: "1m", ts: bucket } },
    });
    if (existing) {
      await this.prisma.candle.update({
        where: { symbol_interval_ts: { symbol: ev.symbol, interval: "1m", ts: bucket } },
        data: {
          high: Math.max(existing.high, ev.price),
          low: Math.min(existing.low, ev.price),
          close: ev.price,
          volume: existing.volume + BigInt(ev.qty),
        },
      });
    } else {
      await this.prisma.candle.create({
        data: {
          symbol: ev.symbol,
          interval: "1m",
          ts: bucket,
          open: ev.price,
          high: ev.price,
          low: ev.price,
          close: ev.price,
          volume: BigInt(ev.qty),
        },
      });
    }
  }
}
