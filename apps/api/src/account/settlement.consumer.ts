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
import { closeMustWaitForTrades, stateAfterClose, stateAfterTrade } from "./settlement-state";

type StreamReply = [key: string, messages: [id: string, fields: string[]][]][] | null;
type StreamMessages = [id: string, fields: string[]][];
type AutoClaimReply = [nextId: string, messages: StreamMessages, deletedIds: string[]];

const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 5_000;

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

  private async processMessages(messages: StreamMessages) {
    for (const [id, fields] of messages) {
      let eventId = id;
      try {
        const idx = fields.indexOf("payload");
        if (idx < 0 || !fields[idx + 1]) throw new Error("stream message has no payload");

        const ev = JSON.parse(fields[idx + 1]) as TradeStreamEvent;
        eventId = ev.eventId;
        if (ev.topic === "trade.executed") await this.settleTrade(ev);
        else if (ev.topic === "order.closed") await this.closeOrder(ev);
        else throw new Error(`unsupported settlement topic: ${(ev as { topic?: string }).topic ?? "unknown"}`);

        await this.stream.xack(STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT, id);
      } catch (e) {
        // Financial events must never be silently discarded.  The pending entry
        // is reclaimed after an idle period, including by a new process after a restart.
        console.error(`[settlement] event failed (retained for retry) ${eventId}`, e);
      }
    }
  }

  private async reclaimPending(consumer: string, cursor: string) {
    const reply = (await this.stream.xautoclaim(
      STREAMS.TRADES,
      CONSUMER_GROUPS.SETTLEMENT,
      consumer,
      CLAIM_IDLE_MS,
      cursor,
      "COUNT",
      100,
    )) as unknown as AutoClaimReply;
    return { nextCursor: reply?.[0] ?? "0-0", messages: reply?.[1] ?? [] };
  }

  private async loop() {
    const consumer = `settlement-${process.pid}`;
    let claimCursor = "0-0";
    let lastClaimAt = 0;

    while (this.running) {
      if (Date.now() - lastClaimAt >= CLAIM_INTERVAL_MS) {
        try {
          const claimed = await this.reclaimPending(consumer, claimCursor);
          claimCursor = claimed.nextCursor;
          await this.processMessages(claimed.messages);
        } catch (e) {
          if (!this.running) return;
          console.error("[settlement] xautoclaim error, retrying", e);
        }
        lastClaimAt = Date.now();
      }

      let reply: StreamReply = null;
      try {
        reply = (await this.stream.xreadgroup(
          "GROUP", CONSUMER_GROUPS.SETTLEMENT, consumer,
          "COUNT", 100,
          "BLOCK", 5000,
          "STREAMS", STREAMS.TRADES, ">",
        )) as StreamReply;
      } catch (e) {
        if (!this.running) return;
        console.error("[settlement] xreadgroup error, retrying", e);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      await this.processMessages(reply?.[0]?.[1] ?? []);
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

      // 보유자산: 매수자 +qty(매입원가 가산), 매도자 -qty(홀드분 소진, 매입원가 비례 차감)
      await ctx.tx.holding.upsert({
        where: { accountId_symbol: { accountId: ev.buyerAccountId, symbol: ev.symbol } },
        update: { qty: { increment: ev.qty }, costBasis: { increment: cost } },
        create: { accountId: ev.buyerAccountId, symbol: ev.symbol, qty: ev.qty, costBasis: cost },
      });
      const sellerHolding = await ctx.tx.holding.findUniqueOrThrow({
        where: { accountId_symbol: { accountId: ev.sellerAccountId, symbol: ev.symbol } },
      });
      // 평단가 유지: 매도 수량만큼 원가를 비례 차감 (qty가 0이 되면 costBasis도 정확히 0)
      const basisReduction =
        sellerHolding.qty > 0
          ? (sellerHolding.costBasis * BigInt(ev.qty)) / BigInt(sellerHolding.qty)
          : 0n;
      await ctx.tx.holding.update({
        where: { accountId_symbol: { accountId: ev.sellerAccountId, symbol: ev.symbol } },
        data: {
          qty: { decrement: ev.qty },
          holdQty: { decrement: ev.qty },
          costBasis: { decrement: basisReduction },
        },
      });

      // 주문 진행 상태 갱신 (종결은 order.closed가 담당)
      for (const order of [buyOrder, sellOrder]) {
        const next = stateAfterTrade(order, ev.qty);
        await ctx.tx.order.update({
          where: { id: order.id },
          data: next,
        });
      }
      return true;
    });

    // Candles are rebuilt from durable trades, so this is safe on a redelivery
    // even when the balance transaction was already committed.
    await this.updateMarket(ev);

    if (!settled) return;

    // 락 밖: 실시간 알림
    this.realtime.notifyAccount(ev.buyerAccountId, { type: "account_update" });
    this.realtime.notifyAccount(ev.sellerAccountId, { type: "account_update" });
  }

  private async closeOrder(ev: OrderClosedEvent) {
    await this.mutator.withAccountLock([ev.accountId], async (ctx) => {
      const dup = await ctx.tx.processedEvent.findUnique({ where: { eventId: ev.eventId } });
      if (dup) return;

      const order = await ctx.tx.order.findUnique({ where: { id: ev.orderId } });
      // A different settlement consumer can receive a later close message
      // while this order's earlier trade messages are still committing.  Do
      // not mark the event processed or release a reservation in that window;
      // keeping it pending lets XAUTOCLAIM retry it after the fills are durable.
      if (order && closeMustWaitForTrades(order, ev)) {
        throw new Error(
          `order.closed is ahead of settled fills for ${ev.orderId}: ${ev.filledQty}/${order.filledQty}`,
        );
      }

      await ctx.tx.processedEvent.create({ data: { eventId: ev.eventId } });
      if (!order) return;
      // 이미 종결됐거나, 현재 정산 수량보다 오래된 close 이벤트는 예약금을 다시 풀면 안 된다.
      const next = stateAfterClose(order, ev);
      if (!next) return;

      await ctx.tx.order.update({
        where: { id: ev.orderId },
        data: { status: next.status, filledQty: next.filledQty },
      });

      const remainingQty = next.remainingQty;
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
    const bucket = new Date(Math.floor(ev.ts / 60_000) * 60_000);
    const bucketEnd = new Date(bucket.getTime() + 60_000);
    const trades = await this.prisma.trade.findMany({
      where: {
        symbol: ev.symbol,
        createdAt: { gte: bucket, lt: bucketEnd },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (trades.length === 0) return;

    const open = trades[0].price;
    const close = trades[trades.length - 1].price;
    const high = Math.max(...trades.map((trade) => trade.price));
    const low = Math.min(...trades.map((trade) => trade.price));
    const volume = trades.reduce((total, trade) => total + BigInt(trade.qty), 0n);

    await this.prisma.candle.upsert({
      where: { symbol_interval_ts: { symbol: ev.symbol, interval: "1m", ts: bucket } },
      update: { open, high, low, close, volume },
      create: { symbol: ev.symbol, interval: "1m", ts: bucket, open, high, low, close, volume },
    });
  }
}
