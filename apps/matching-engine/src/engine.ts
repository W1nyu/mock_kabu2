import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@mock-kabu/db";
import {
  CHANNELS,
  KEYS,
  SYMBOLS,
  STREAMS,
  type OrderClosedEvent,
  type OrderStreamEvent,
  type OrderbookSnapshot,
  type TradeExecutedEvent,
  type TradeStreamEvent,
  type TradeTick,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import {
  applyOrder,
  cancelOrder,
  createBook,
  levels,
  remainingRestingQty,
  type MatchResult,
  type Orderbook,
  type RestingOrder,
} from "./orderbook";

const DEPTH = 10;
// bot11..bot15 can contain an interrupted trial generation.  The API creates
// bot16+ as the clean, symbol-scoped liquidity reserve generation.
// Keep this matching-side identity check deliberately exact so ordinary bot
// or user accounts can never gain bootstrap priority.
const LIQUIDITY_RESERVE_START_INDEX = 16;
const reserveSymbolByEmail = new Map(
  SYMBOLS.map((symbol, index) => [`bot${LIQUIDITY_RESERVE_START_INDEX + index}@bots.local`, symbol.symbol]),
);

type PlacedOrderEvent = Extract<OrderStreamEvent, { topic: "order.placed" }>;

interface PersistedTrade {
  id: string;
  createdAt: Date;
  fill: MatchResult["fills"][number];
}

interface SettlementOutboxRecord {
  id: bigint;
  eventId: string;
  payload: unknown;
}

const SETTLEMENT_OUTBOX_BATCH = 500;

interface HandleEventOptions {
  /** Pending entries claimed from a previous consumer need the legacy DB fallback. */
  recovery?: boolean;
}

/**
 * applyOrder/cancelOrder는 입력 book을 직접 변경한다. DB 트랜잭션이 실패했을 때
 * 메모리 북만 앞서 가지 않도록, 이벤트 결과는 복제본에서 먼저 계산한다.
 */
function cloneBook(book: Orderbook): Orderbook {
  return {
    ...book,
    bids: book.bids.map((order) => ({ ...order })),
    asks: book.asks.map((order) => ({ ...order })),
  };
}

/**
 * On restart, preserve the earliest chronological resting order and quarantine
 * a later DB row that would recreate a crossed executable book. This is an
 * in-memory safety boundary only: no historical order, reservation, or user
 * balance is changed here.
 */
function crossesRestoredBook(book: Orderbook, side: "BUY" | "SELL", price: number): boolean {
  if (side === "BUY") {
    const bestAsk = book.asks.reduce<number | undefined>(
      (best, order) => (best === undefined || order.price < best ? order.price : best),
      undefined,
    );
    return bestAsk !== undefined && price >= bestAsk;
  }
  const bestBid = book.bids.reduce<number | undefined>(
    (best, order) => (best === undefined || order.price > best ? order.price : best),
    undefined,
  );
  return bestBid !== undefined && price <= bestBid;
}

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

  /**
   * Return only the symbol-scoped bot16+ account IDs, paired with their one
   * allowed symbol.  We intentionally resolve this through both auth.users
   * and account.accounts instead of trusting an order's accountId or any
   * nickname.  Existing databases created before the reserve feature simply
   * return an empty map and retain the normal legacy replay behavior.
   */
  private async dedicatedReserveAccountSymbols(): Promise<Map<string, string>> {
    // Lightweight test fakes from the pre-reserve recovery suite do not need
    // auth/account models.  Production Prisma always provides both delegates.
    if (!this.prisma.user || !this.prisma.account) return new Map();

    const reserveEmails = [...reserveSymbolByEmail.keys()];
    const users = await this.prisma.user.findMany({
      where: { isBot: true, email: { in: reserveEmails } },
      select: { id: true, email: true },
    });
    if (users.length === 0) return new Map();

    const symbolByUserId = new Map<string, string>();
    for (const user of users) {
      const symbol = reserveSymbolByEmail.get(user.email);
      if (symbol) symbolByUserId.set(user.id, symbol);
    }
    if (symbolByUserId.size === 0) return new Map();

    const accounts = await this.prisma.account.findMany({
      where: { userId: { in: [...symbolByUserId.keys()] } },
      select: { id: true, userId: true },
    });
    const symbolByAccountId = new Map<string, string>();
    for (const account of accounts) {
      const symbol = symbolByUserId.get(account.userId);
      if (symbol) symbolByAccountId.set(account.id, symbol);
    }
    return symbolByAccountId;
  }

  /**
   * `order.closed` is durable in the matching outbox before the asynchronous
   * account consumer turns the order row terminal. During that gap this marker
   * is the authoritative signal that the order must never re-enter a book.
   * The delegate guard keeps older lightweight unit-test fakes compatible;
   * production Prisma always provides it after the accompanying migration.
   */
  private async durableCloseMarkerIds(orderIds: Iterable<string>): Promise<Set<string>> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0 || !this.prisma.matchingClosedOrderMarker) return new Set();
    const rows = await this.prisma.matchingClosedOrderMarker.findMany({
      where: { orderId: { in: ids } },
      select: { orderId: true },
    });
    return new Set(rows.map((row) => row.orderId));
  }

  /** Remove orders a different/stale engine instance has already closed. */
  private async pruneDurablyClosedOrders(book: Orderbook): Promise<boolean> {
    const markerIds = await this.durableCloseMarkerIds([...book.bids, ...book.asks].map((order) => order.orderId));
    let changed = false;
    for (const orderId of markerIds) {
      if (cancelOrder(book, orderId)) changed = true;
    }
    return changed;
  }

  private bookContainsOrder(book: Orderbook, orderId: string): boolean {
    return [...book.bids, ...book.asks].some((order) => order.orderId === orderId);
  }

  async bootstrap(): Promise<void> {
    // The DB can retain delisted rows as historical data while runtime books
    // only exist for the currently configured exchange symbols.
    const activeSymbolList = SYMBOLS.map((symbol) => symbol.symbol);
    const activeSymbols = new Set(activeSymbolList);
    const persistedSymbols = await this.prisma.marketSymbol.findMany();
    const symbols = persistedSymbols.filter((symbol) => activeSymbols.has(symbol.symbol));
    const restoredSymbols = await Promise.all(
      symbols.map(async (symbol) => {
        // 정산 소비자가 잠시 멈췄어도 matching.trades는 체결과 함께 남는다.
        // 재기동 시에는 캐시보다 실제 마지막 체결가를 우선한다.
        const latestTrade = await this.prisma.trade.findFirst({
          where: { symbol: symbol.symbol },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { price: true },
        });
        return { symbol, lastPrice: latestTrade?.price ?? symbol.lastPrice, hadTrade: latestTrade != null };
      }),
    );
    for (const restored of restoredSymbols) {
      this.books.set(restored.symbol.symbol, createBook(restored.symbol.symbol, restored.lastPrice));
    }
    // 이전 버전에서 정산 지연으로 last_price 캐시가 뒤처진 경우도, 원장인
    // matching.trades를 기준으로 비파괴적으로 보정한다.
    const stalePriceCaches = restoredSymbols.filter(
      ({ symbol, lastPrice }) => symbol.lastPrice !== lastPrice,
    );
    await Promise.all(
      stalePriceCaches.map(({ symbol, lastPrice }) =>
        this.prisma.marketSymbol.update({
          where: { symbol: symbol.symbol },
          data: { lastPrice },
        }),
      ),
    );

    const [open, reserveAccountSymbols] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          symbol: { in: activeSymbolList },
          status: { in: ["OPEN", "PARTIAL"] },
          type: "LIMIT",
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.dedicatedReserveAccountSymbols(),
    ]);
    const closePendingIds = await this.durableCloseMarkerIds(open.map((order) => order.id));
    const replayableOpen = open.filter((order) => !closePendingIds.has(order.id));
    // A reserve row is trusted only when the account belongs to the exact
    // bot16+ identity and the order is for that account's one assigned
    // symbol.  Replaying those intact ladders first establishes a non-crossed
    // executable base; legacy/user rows are then admitted only if they do not
    // cross it.  This is strictly an in-memory restart policy, never a DB
    // repair or mutation of historical orders.
    const isDedicatedReserveOrder = (order: { accountId: string; symbol: string }) =>
      reserveAccountSymbols.get(order.accountId) === order.symbol;
    const reserveOpen = replayableOpen.filter(isDedicatedReserveOrder);
    const replayOrder = [
      ...reserveOpen,
      ...replayableOpen.filter((order) => !isDedicatedReserveOrder(order)),
    ];
    const orderIds = replayableOpen.map((order) => order.id);
    const [buyFills, sellFills] = orderIds.length
      ? await Promise.all([
          this.prisma.trade.groupBy({
            by: ["buyOrderId"],
            where: { buyOrderId: { in: orderIds } },
            _sum: { qty: true },
          }),
          this.prisma.trade.groupBy({
            by: ["sellOrderId"],
            where: { sellOrderId: { in: orderIds } },
            _sum: { qty: true },
          }),
        ])
      : [[], []];
    const buyFilledQty = new Map(buyFills.map((row) => [row.buyOrderId, row._sum.qty ?? 0]));
    const sellFilledQty = new Map(sellFills.map((row) => [row.sellOrderId, row._sum.qty ?? 0]));
    let replayed = 0;
    let reserveReplayed = 0;
    let skippedCompleted = 0;
    let quarantinedCrossed = 0;
    for (const o of replayOrder) {
      const book = this.books.get(o.symbol);
      if (!book || o.price == null) continue;
      const recordedTradeQty = o.side === "BUY" ? (buyFilledQty.get(o.id) ?? 0) : (sellFilledQty.get(o.id) ?? 0);
      const remainingQty = remainingRestingQty(o.qty, o.filledQty, recordedTradeQty);
      if (remainingQty === 0) {
        skippedCompleted++;
        continue;
      }
      if (crossesRestoredBook(book, o.side as "BUY" | "SELL", o.price)) {
        quarantinedCrossed++;
        continue;
      }
      book.seq++;
      const resting: RestingOrder = {
        orderId: o.id,
        accountId: o.accountId,
        side: o.side as "BUY" | "SELL",
        price: o.price,
        qty: remainingQty,
        totalQty: o.qty,
        seq: book.seq,
      };
      // 리플레이는 매칭 없이 등재만 한다 (교차분은 이미 과거에 체결됨)
      const list = resting.side === "BUY" ? book.bids : book.asks;
      list.push(resting);
      replayed++;
      if (isDedicatedReserveOrder(o)) reserveReplayed++;
    }
    for (const book of this.books.values()) {
      book.bids.sort((a, b) => b.price - a.price || a.seq - b.seq);
      book.asks.sort((a, b) => a.price - b.price || a.seq - b.seq);
    }
    console.log(
      `[engine] bootstrap: ${symbols.length} symbols, ${replayed}/${replayableOpen.length} replayable open orders (${closePendingIds.size} close-pending skipped; ${reserveReplayed}/${reserveOpen.length} dedicated reserve rows first; ${skippedCompleted} already matched, ${quarantinedCrossed} crossed rows quarantined in-memory), ${restoredSymbols.filter((symbol) => symbol.hadTrade).length} prices restored from trades (${stalePriceCaches.length} cache repairs)`,
    );
  }

  /**
   * 이전 버전이 남긴 이벤트와, processed_order_events 도입 직후의 이벤트를 위한
   * 데이터 기반 fallback이다. outbox는 XADD와 publishedAt 마킹 사이에 같은
   * eventId를 다시 발행할 수 있으므로, 전달 방식과 무관하게 항상 확인한다.
   */
  private async alreadyApplied(ev: OrderStreamEvent): Promise<boolean> {
    if ((await this.durableCloseMarkerIds([ev.orderId])).has(ev.orderId)) return true;
    if (ev.topic === "order.cancel.requested") {
      const order = await this.prisma.order.findUnique({ where: { id: ev.orderId } });
      return order == null || !["OPEN", "PARTIAL"].includes(order.status);
    }
    const book = this.books.get(ev.symbol);
    if (book && [...book.bids, ...book.asks].some((o) => o.orderId === ev.orderId)) return true;
    const order = await this.prisma.order.findUnique({ where: { id: ev.orderId } });
    if (order && order.status !== "OPEN") return true;
    const traded = await this.prisma.trade.findFirst({
      where: { OR: [{ buyOrderId: ev.orderId }, { sellOrderId: ev.orderId }] },
    });
    return traded != null;
  }

  /** A normal cancel only needs to reject a close that was already decided. */
  private async hasDurableCloseMarker(orderId: string): Promise<boolean> {
    return (await this.durableCloseMarkerIds([orderId])).has(orderId);
  }

  private rememberEvent(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > MatchingEngine.SEEN_CAP) {
      const first = this.seenEventIds.values().next().value as string;
      this.seenEventIds.delete(first);
    }
  }

  /**
   * A restart can leave an active DB order out of the in-memory book when its
   * replayed remaining quantity is zero or an earlier process lost its
   * snapshot. A cancel request must not remain OPEN forever in that case.
   *
   * Recorded matching quantity is only a guard: a normal order.closed event is
   * emitted when it agrees exactly with the settlement row. A mismatch is left
   * for the explicit recovery workflow and is never auto-repaired here.
   */
  private async closeMissingBookOrder(
    ev: Extract<OrderStreamEvent, { topic: "order.cancel.requested" }>,
  ): Promise<OrderClosedEvent | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: ev.orderId },
      select: {
        id: true,
        accountId: true,
        symbol: true,
        side: true,
        qty: true,
        filledQty: true,
        status: true,
      },
    });
    if (!order || !["OPEN", "PARTIAL"].includes(order.status)) return null;
    if (order.symbol !== ev.symbol || !["BUY", "SELL"].includes(order.side)) {
      console.warn(`[engine] refuse orphan cancel with invalid order identity: ${ev.orderId}`);
      return null;
    }

    const aggregate = await this.prisma.trade.aggregate({
      where: order.side === "BUY" ? { buyOrderId: order.id } : { sellOrderId: order.id },
      _sum: { qty: true },
    });
    const recordedQty = aggregate._sum.qty ?? 0;
    const isValidQty =
      Number.isSafeInteger(order.qty) &&
      Number.isSafeInteger(order.filledQty) &&
      order.qty > 0 &&
      order.filledQty >= 0 &&
      order.filledQty <= order.qty;
    if (!isValidQty || recordedQty !== order.filledQty) {
      console.warn(
        `[engine] refuse orphan cancel with settlement mismatch: ${ev.orderId} db=${order.filledQty}/${order.qty} trades=${recordedQty}`,
      );
      return null;
    }

    return {
      topic: "order.closed",
      eventId: randomUUID(),
      orderId: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side as "BUY" | "SELL",
      filledQty: order.filledQty,
      status: order.filledQty === order.qty ? "FILLED" : "CANCELED",
      reason: "orphaned_book_cancel",
      ts: Date.now(),
    };
  }

  /**
   * Redis Streams는 at-least-once이므로 eventId를 DB에서 원자적으로 claim한다.
   * Prisma Client 재생성 전에도 동작하도록 raw query를 쓴다. 해당 테이블은
   * 20260713090000_add_matching_processed_order_events migration이 만든다.
   */
  private async claimEvent(tx: any, eventId: string): Promise<boolean> {
    const rows = (await tx.$queryRaw`
      INSERT INTO "matching"."processed_order_events" ("event_id")
      VALUES (${eventId})
      ON CONFLICT ("event_id") DO NOTHING
      RETURNING "event_id"
    `) as { event_id: string }[];
    return rows.length === 1;
  }

  /**
   * Bootstrap can restore a still-open limit order before its first stream
   * delivery is consumed. Record that delivery without rematching the already
   * resting row, so a later outbox retry cannot revive it after cancellation.
   */
  private async claimAlreadyRestingPlacedEvent(eventId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.claimEvent(tx, eventId);
    });
  }

  /**
   * 체결 원장, last_price, 이벤트 claim을 하나의 DB 트랜잭션으로 확정한다.
   * 따라서 같은 order.placed eventId가 다른 Redis 엔트리로 재전달되어도
   * 한 번만 matching.trades에 기록된다.
   */
  private settlementEventsForResult(
    book: Pick<Orderbook, "symbol">,
    result: MatchResult,
    trades: PersistedTrade[],
  ): TradeStreamEvent[] {
    const tradeEvents: TradeExecutedEvent[] = trades.map((trade) => {
      const { fill } = trade;
      const buyOrderId = fill.takerSide === "BUY" ? fill.takerOrderId : fill.makerOrderId;
      const sellOrderId = fill.takerSide === "SELL" ? fill.takerOrderId : fill.makerOrderId;
      const buyerAccountId = fill.takerSide === "BUY" ? fill.takerAccountId : fill.makerAccountId;
      const sellerAccountId = fill.takerSide === "SELL" ? fill.takerAccountId : fill.makerAccountId;
      return {
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
    });
    const closedEvents: OrderClosedEvent[] = result.closedOrders.map((closed) => ({
      topic: "order.closed",
      eventId: randomUUID(),
      orderId: closed.orderId,
      accountId: closed.accountId,
      symbol: book.symbol,
      side: closed.side,
      filledQty: closed.filledQty,
      status: closed.status,
      ts: Date.now(),
    }));
    // A close must not overtake any fill that it describes. The auto-increment
    // outbox id retains this order even if relay retries across a restart.
    return [...tradeEvents, ...closedEvents];
  }

  private async persistSettlementEvents(tx: any, events: TradeStreamEvent[]): Promise<void> {
    for (const event of events) {
      if (event.topic === "order.closed" && tx.matchingClosedOrderMarker) {
        // Keep the marker and settlement outbox in this same transaction. A
        // retry may describe the same order again, but its first terminal
        // decision remains authoritative while settlement is catching up.
        await tx.matchingClosedOrderMarker.upsert({
          where: { orderId: event.orderId },
          create: { orderId: event.orderId, eventId: event.eventId },
          update: {},
        });
      }
      await tx.matchingOutboxEvent.create({
        data: {
          eventId: event.eventId,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async persistPlacedEvent(
    ev: PlacedOrderEvent,
    book: Orderbook,
    result: MatchResult,
  ): Promise<{ applied: boolean; hasSettlementEvents: boolean }> {
    const trades: PersistedTrade[] = result.fills.map((fill) => ({
      id: randomUUID(),
      createdAt: new Date(),
      fill,
    }));
    const settlementEvents = this.settlementEventsForResult(book, result, trades);

    const applied = await this.prisma.$transaction(async (tx) => {
      if (!(await this.claimEvent(tx, ev.eventId))) return false;

      for (const trade of trades) {
        const { fill } = trade;
        const buyOrderId = fill.takerSide === "BUY" ? fill.takerOrderId : fill.makerOrderId;
        const sellOrderId = fill.takerSide === "SELL" ? fill.takerOrderId : fill.makerOrderId;
        const buyerAccountId = fill.takerSide === "BUY" ? fill.takerAccountId : fill.makerAccountId;
        const sellerAccountId = fill.takerSide === "SELL" ? fill.takerAccountId : fill.makerAccountId;
        await tx.trade.create({
          data: {
            id: trade.id,
            symbol: book.symbol,
            price: fill.price,
            qty: fill.qty,
            buyOrderId,
            sellOrderId,
            buyerAccountId,
            sellerAccountId,
            takerSide: fill.takerSide,
            createdAt: trade.createdAt,
          },
        });
      }

      if (trades.length > 0) {
        await tx.marketSymbol.update({
          where: { symbol: book.symbol },
          data: { lastPrice: trades[trades.length - 1].fill.price },
        });
      }
      await this.persistSettlementEvents(tx, settlementEvents);
      return true;
    });

    return { applied, hasSettlementEvents: settlementEvents.length > 0 };
  }

  /** A cancellation owns one durable close event, including across retries. */
  private async persistCancelEvent(
    ev: Extract<OrderStreamEvent, { topic: "order.cancel.requested" }>,
    closed: OrderClosedEvent | null,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.claimEvent(tx, ev.eventId))) return false;
      if (closed) await this.persistSettlementEvents(tx, [closed]);
      return true;
    });
  }

  private parseSettlementOutboxPayload(payload: unknown): TradeStreamEvent {
    if (!payload || typeof payload !== "object") {
      throw new Error("matching outbox payload is not an object");
    }
    const event = payload as Partial<TradeStreamEvent>;
    if (
      (event.topic !== "trade.executed" && event.topic !== "order.closed") ||
      typeof event.eventId !== "string" ||
      event.eventId.length === 0
    ) {
      throw new Error("matching outbox payload has an invalid event identity");
    }
    return event as TradeStreamEvent;
  }

  /**
   * XADD only after the durable row exists, then mark it published. If the
   * process dies between those calls, the same eventId can be emitted again
   * safely because account.processed_events makes settlement idempotent.
   */
  async flushSettlementOutbox(): Promise<number> {
    // Lightweight unit-test fakes predating the outbox intentionally omit this
    // delegate. Production Prisma always provides it after the migration.
    if (!this.prisma.matchingOutboxEvent) return 0;
    const rows = (await this.prisma.matchingOutboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { id: "asc" },
      take: SETTLEMENT_OUTBOX_BATCH,
    })) as SettlementOutboxRecord[];

    for (const row of rows) {
      const event = this.parseSettlementOutboxPayload(row.payload);
      await this.publishTradeStream(event);
      await this.prisma.matchingOutboxEvent.updateMany({
        where: { id: row.id, publishedAt: null },
        data: { publishedAt: new Date() },
      });

      if (event.topic === "trade.executed") {
        const tick: TradeTick = {
          tradeId: event.tradeId,
          symbol: event.symbol,
          price: event.price,
          qty: event.qty,
          takerSide: event.takerSide,
          ts: event.ts,
        };
        try {
          await this.publisher.publish(CHANNELS.trades(event.symbol), JSON.stringify(tick));
        } catch (error) {
          // The durable trade stream is already published. Missing a best-effort
          // browser tick must not make the financial event retry indefinitely.
          console.warn(`[engine] realtime tick publish failed for ${event.eventId}`, error);
        }
      }
    }
    return rows.length;
  }

  private async flushSettlementOutboxSafely(context: string): Promise<void> {
    try {
      await this.flushSettlementOutbox();
    } catch (error) {
      // The source order may be ACKed: the durable row remains unpublished and
      // the one-second relay or the next engine bootstrap will retry it.
      console.error(`[engine] settlement outbox relay failed (${context})`, error);
    }
  }

  async handleEvent(ev: OrderStreamEvent, options: HandleEventOptions = {}): Promise<void> {
    const book = this.books.get(ev.symbol);
    if (!book) {
      // A de-listed symbol can be ACKed only after its order is terminal. If
      // it is still open, leaving the message pending prevents a live order
      // and its reservation from being silently lost before the retirement
      // migration has released it.
      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: { symbol: true, status: true },
      });
      if (order?.symbol === ev.symbol && ["OPEN", "PARTIAL"].includes(order.status)) {
        throw new Error(`[engine] active order for unconfigured symbol: ${ev.symbol}/${ev.orderId}`);
      }
      console.warn(`[engine] skip terminal or unknown symbol event: ${ev.symbol}/${ev.orderId}`);
      return;
    }

    // A former engine can retain a book row after another instance has
    // durably closed it. Remove those rows before any incoming order is
    // matched, so a stale in-memory book cannot revive a canceled order.
    if (await this.pruneDurablyClosedOrders(book)) {
      await this.publishSnapshot(book);
    }

    if (this.seenEventIds.has(ev.eventId)) {
      await this.flushSettlementOutboxSafely("duplicate-memory");
      console.log(`[engine] skip duplicate event ${ev.eventId}`);
      return;
    }
    // A placed event is authoritatively deduplicated by the event-id claim in
    // persistPlacedEvent's transaction.  Fresh events used to pay several
    // redundant DB reads before reaching that claim.  Keep the older data
    // fallback only for pending messages reclaimed from a prior consumer.
    let alreadyApplied = false;
    if (ev.topic === "order.placed") {
      if (this.bookContainsOrder(book, ev.orderId)) {
        await this.claimAlreadyRestingPlacedEvent(ev.eventId);
        alreadyApplied = true;
      } else if (await this.hasDurableCloseMarker(ev.orderId)) {
        alreadyApplied = true;
      } else if (options.recovery) {
        alreadyApplied = await this.alreadyApplied(ev);
      }
    } else if (!options.recovery) {
      alreadyApplied = await this.hasDurableCloseMarker(ev.orderId);
    } else {
      alreadyApplied = await this.alreadyApplied(ev);
    }
    if (alreadyApplied) {
      this.rememberEvent(ev.eventId);
      await this.flushSettlementOutboxSafely("already-applied");
      console.log(`[engine] skip previously-applied event ${ev.eventId}`);
      return;
    }

    if (ev.topic === "order.placed") {
      const stagedBook = cloneBook(book);
      const result = applyOrder(stagedBook, {
        orderId: ev.orderId,
        accountId: ev.accountId,
        side: ev.side,
        type: ev.type,
        price: ev.price,
        qty: ev.qty,
        ts: ev.ts,
      });
      const persisted = await this.persistPlacedEvent(ev, stagedBook, result);
      if (!persisted.applied) {
        this.rememberEvent(ev.eventId);
        await this.flushSettlementOutboxSafely("duplicate-claim");
        console.log(`[engine] skip duplicate event ${ev.eventId}`);
        return;
      }
      this.books.set(ev.symbol, stagedBook);
      this.rememberEvent(ev.eventId);
      if (persisted.hasSettlementEvents) {
        await this.flushSettlementOutboxSafely("placed");
      }
      await this.publishSnapshot(stagedBook);
    } else if (ev.topic === "order.cancel.requested") {
      const stagedBook = cloneBook(book);
      const removed = cancelOrder(stagedBook, ev.orderId);
      let closed: OrderClosedEvent | null = null;
      if (removed) {
        closed = {
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
      } else {
        closed = await this.closeMissingBookOrder(ev);
      }
      const applied = await this.persistCancelEvent(ev, closed);
      if (!applied) {
        this.rememberEvent(ev.eventId);
        await this.flushSettlementOutboxSafely("duplicate-cancel-claim");
        console.log(`[engine] skip duplicate cancel ${ev.eventId}`);
        return;
      }
      this.books.set(ev.symbol, stagedBook);
      this.rememberEvent(ev.eventId);
      if (closed) await this.flushSettlementOutboxSafely("cancel");
      // 북에 없으면 이미 체결/취소된 것 — 무시 (멱등)
      await this.publishSnapshot(stagedBook);
      // close 이벤트와 스냅샷 발행이 모두 성공한 뒤에만 메모리 북을 교체한다.
      // 실패 시 원래 book을 유지해 pending 메시지 재시도에서 close를 다시 발행하며,
      // settlement의 상태 전이 가드가 그 재발행을 안전하게 흡수한다.
    }
  }

  private async publishTradeStream(ev: TradeStreamEvent): Promise<void> {
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
    // Pipelining preserves the command order while avoiding a second Redis
    // round trip for every matched or resting order.
    const pipeline = this.publisher.pipeline?.();
    if (pipeline) {
      pipeline.publish(CHANNELS.orderbook(book.symbol), json);
      pipeline.set(KEYS.orderbookSnapshot(book.symbol), json);
      await pipeline.exec();
    } else {
      // Keep lightweight unit-test fakes compatible with the production
      // pipeline path.
      await this.publisher.publish(CHANNELS.orderbook(book.symbol), json);
      await this.publisher.set(KEYS.orderbookSnapshot(book.symbol), json);
    }
  }

  /** 접속 직후 스냅샷 제공용 (api가 요청 시 재발행) */
  async publishAllSnapshots(): Promise<void> {
    for (const book of this.books.values()) {
      await this.publishSnapshot(book);
    }
  }
}
