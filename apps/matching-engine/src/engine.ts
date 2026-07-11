import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@mock-kabu/db";
import {
  CHANNELS,
  KEYS,
  STREAMS,
  type OrderClosedEvent,
  type OrderStreamEvent,
  type OrderbookSnapshot,
  type TradeExecutedEvent,
  type TradeTick,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import {
  applyOrder,
  cancelOrder,
  createBook,
  levels,
  type MatchResult,
  type Orderbook,
  type RestingOrder,
} from "./orderbook";

const DEPTH = 10;

export class MatchingEngine {
  private books = new Map<string, Orderbook>();
  /** outbox 재발행 등으로 인한 중복 이벤트 방어 (최근 이벤트 id 기억) */
  private seenEventIds = new Set<string>();
  private static readonly SEEN_CAP = 10_000;

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private publisher: Redis,
  ) {}

  /** 심볼 로드 + 미체결(OPEN/PARTIAL) 주문 리플레이로 오더북 복원 */
  async bootstrap(): Promise<void> {
    const symbols = await this.prisma.marketSymbol.findMany();
    for (const s of symbols) {
      this.books.set(s.symbol, createBook(s.symbol, s.lastPrice));
    }

    const open = await this.prisma.order.findMany({
      where: { status: { in: ["OPEN", "PARTIAL"] }, type: "LIMIT" },
      orderBy: { createdAt: "asc" },
    });
    for (const o of open) {
      const book = this.books.get(o.symbol);
      if (!book || o.price == null) continue;
      book.seq++;
      const resting: RestingOrder = {
        orderId: o.id,
        accountId: o.accountId,
        side: o.side as "BUY" | "SELL",
        price: o.price,
        qty: o.qty - o.filledQty,
        totalQty: o.qty,
        seq: book.seq,
      };
      // 리플레이는 매칭 없이 등재만 한다 (교차분은 이미 과거에 체결됨)
      const list = resting.side === "BUY" ? book.bids : book.asks;
      list.push(resting);
    }
    for (const book of this.books.values()) {
      book.bids.sort((a, b) => b.price - a.price || a.seq - b.seq);
      book.asks.sort((a, b) => a.price - b.price || a.seq - b.seq);
    }
    console.log(
      `[engine] bootstrap: ${symbols.length} symbols, ${open.length} open orders replayed`,
    );
  }

  /** 재전달(pending) 메시지가 이미 반영됐는지 확인 */
  private async alreadyApplied(ev: OrderStreamEvent): Promise<boolean> {
    if (ev.topic !== "order.placed") return false;
    const book = this.books.get(ev.symbol);
    if (book && [...book.bids, ...book.asks].some((o) => o.orderId === ev.orderId)) return true;
    const order = await this.prisma.order.findUnique({ where: { id: ev.orderId } });
    if (order && order.status !== "OPEN") return true;
    const traded = await this.prisma.trade.findFirst({
      where: { OR: [{ buyOrderId: ev.orderId }, { sellOrderId: ev.orderId }] },
    });
    return traded != null;
  }

  async handleEvent(ev: OrderStreamEvent, redelivered: boolean): Promise<void> {
    const book = this.books.get(ev.symbol);
    if (!book) {
      console.warn(`[engine] unknown symbol: ${ev.symbol}`);
      return;
    }

    if (this.seenEventIds.has(ev.eventId)) {
      console.log(`[engine] skip duplicate event ${ev.eventId}`);
      return;
    }
    if (redelivered && (await this.alreadyApplied(ev))) {
      console.log(`[engine] skip already-applied event ${ev.eventId}`);
      return;
    }
    this.seenEventIds.add(ev.eventId);
    if (this.seenEventIds.size > MatchingEngine.SEEN_CAP) {
      const first = this.seenEventIds.values().next().value as string;
      this.seenEventIds.delete(first);
    }

    if (ev.topic === "order.placed") {
      const result = applyOrder(book, {
        orderId: ev.orderId,
        accountId: ev.accountId,
        side: ev.side,
        type: ev.type,
        price: ev.price,
        qty: ev.qty,
        ts: ev.ts,
      });
      await this.emitMatchResult(book, result);
    } else if (ev.topic === "order.cancel.requested") {
      const removed = cancelOrder(book, ev.orderId);
      if (removed) {
        const closed: OrderClosedEvent = {
          topic: "order.closed",
          eventId: randomUUID(),
          orderId: removed.orderId,
          accountId: removed.accountId,
          symbol: ev.symbol,
          side: removed.side,
          filledQty: removed.totalQty - removed.qty,
          status: "CANCELED",
          reason: "user_cancel",
          ts: Date.now(),
        };
        await this.publishTradeStream(closed);
      }
      // 북에 없으면 이미 체결/취소된 것 — 무시 (멱등)
    }

    await this.publishSnapshot(book);
  }

  private async emitMatchResult(book: Orderbook, result: MatchResult): Promise<void> {
    for (const fill of result.fills) {
      const buyOrderId = fill.takerSide === "BUY" ? fill.takerOrderId : fill.makerOrderId;
      const sellOrderId = fill.takerSide === "SELL" ? fill.takerOrderId : fill.makerOrderId;
      const buyerAccountId = fill.takerSide === "BUY" ? fill.takerAccountId : fill.makerAccountId;
      const sellerAccountId = fill.takerSide === "SELL" ? fill.takerAccountId : fill.makerAccountId;

      const trade = await this.prisma.trade.create({
        data: {
          symbol: book.symbol,
          price: fill.price,
          qty: fill.qty,
          buyOrderId,
          sellOrderId,
          buyerAccountId,
          sellerAccountId,
          takerSide: fill.takerSide,
        },
      });

      const ev: TradeExecutedEvent = {
        topic: "trade.executed",
        eventId: trade.id,
        tradeId: trade.id,
        symbol: book.symbol,
        price: fill.price,
        qty: fill.qty,
        buyOrderId,
        sellOrderId,
        buyerAccountId,
        sellerAccountId,
        takerSide: fill.takerSide,
        ts: trade.createdAt.getTime(),
      };
      await this.publishTradeStream(ev);

      const tick: TradeTick = {
        tradeId: trade.id,
        symbol: book.symbol,
        price: fill.price,
        qty: fill.qty,
        takerSide: fill.takerSide,
        ts: ev.ts,
      };
      await this.publisher.publish(CHANNELS.trades(book.symbol), JSON.stringify(tick));
    }

    for (const closed of result.closedOrders) {
      const ev: OrderClosedEvent = {
        topic: "order.closed",
        eventId: randomUUID(),
        orderId: closed.orderId,
        accountId: closed.accountId,
        symbol: book.symbol,
        side: closed.side,
        filledQty: closed.filledQty,
        status: closed.status,
        ts: Date.now(),
      };
      await this.publishTradeStream(ev);
    }
  }

  private async publishTradeStream(ev: TradeExecutedEvent | OrderClosedEvent): Promise<void> {
    await this.redis.xadd(STREAMS.TRADES, "*", "payload", JSON.stringify(ev));
  }

  async publishSnapshot(book: Orderbook): Promise<void> {
    book.seq++;
    const { bids, asks } = levels(book, DEPTH);
    const snapshot: OrderbookSnapshot = {
      symbol: book.symbol,
      bids,
      asks,
      lastPrice: book.lastPrice,
      seq: book.seq,
      ts: Date.now(),
    };
    const json = JSON.stringify(snapshot);
    await this.publisher.publish(CHANNELS.orderbook(book.symbol), json);
    await this.publisher.set(KEYS.orderbookSnapshot(book.symbol), json);
  }

  /** 접속 직후 스냅샷 제공용 (api가 요청 시 재발행) */
  async publishAllSnapshots(): Promise<void> {
    for (const book of this.books.values()) {
      await this.publishSnapshot(book);
    }
  }
}
