import { randomUUID } from "node:crypto";
import { createBalanceMutator, type BalanceMutator } from "@mock-kabu/concurrency";
import { getPrisma, type PrismaClient } from "@mock-kabu/db";
import {
  CHANNELS,
  CONSUMER_GROUPS,
  KEYS,
  STREAM_RETENTION,
  STREAMS,
  WORKERS,
  closeMustWaitForTrades,
  realizedPnlForSale,
  stateAfterClose,
  stateAfterTrade,
  type OrderClosedEvent,
  type TradeExecutedEvent,
  type TradeStreamEvent,
  trimAcknowledgedStream,
  futureDef,
  isFuture,
} from "@mock-kabu/shared";
import Redis from "ioredis";
import { readSettlementRuntimeConfig } from "./env";
import { settleFuturesTrade } from "./futures";

type StreamReply = [key: string, messages: StreamMessages][] | null;
type StreamMessages = [id: string, fields: string[]][];
type AutoClaimReply = [nextId: string, messages: StreamMessages, deletedIds: string[]];

const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TTL_SECONDS = 15;
const RETAINED_FAILURE_LOG_WINDOW_MS = 60_000;
const RETAINED_FAILURE_LOG_LIMIT = 5;
const CLEAR_HEARTBEAT_IF_OWNER = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1], KEYS[2])
  end
  return 0
`;
const PUBLISH_HEARTBEAT = `
  local current = redis.call("GET", KEYS[1])
  if current and current ~= ARGV[1] then
    return 0
  end
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  return 1
`;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Reject malformed Redis rows before they reach account and ledger mutations. */
function isTradeStreamEvent(value: unknown): value is TradeStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.symbol) ||
    typeof event.ts !== "number" ||
    !Number.isFinite(event.ts)
  ) {
    return false;
  }

  if (event.topic === "trade.executed") {
    return (
      isNonEmptyString(event.tradeId) &&
      isNonEmptyString(event.buyOrderId) &&
      isNonEmptyString(event.sellOrderId) &&
      isNonEmptyString(event.buyerAccountId) &&
      isNonEmptyString(event.sellerAccountId) &&
      (event.takerSide === "BUY" || event.takerSide === "SELL") &&
      Number.isSafeInteger(event.price) &&
      (event.price as number) > 0 &&
      Number.isSafeInteger(event.qty) &&
      (event.qty as number) > 0
    );
  }

  return (
    event.topic === "order.closed" &&
    isNonEmptyString(event.orderId) &&
    isNonEmptyString(event.accountId) &&
    (event.side === "BUY" || event.side === "SELL") &&
    (event.status === "FILLED" || event.status === "CANCELED" || event.status === "REJECTED") &&
    Number.isSafeInteger(event.filledQty) &&
    (event.filledQty as number) >= 0 &&
    (event.reason === undefined || typeof event.reason === "string")
  );
}

/**
 * Owns the settlement side of the exchange pipeline. It deliberately does not
 * depend on Nest or Socket.IO: database commits and account invalidations can
 * now continue independently of how many stateless API replicas are serving
 * REST/WebSocket traffic.
 */
class SettlementWorker {
  private running = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private streamTrimTimer: NodeJS.Timeout | undefined;
  private readonly heartbeatToken = randomUUID();
  private readonly retainedEventIds = new Set<string>();
  private failureLogWindowStartedAt = 0;
  private failureLogsInWindow = 0;
  private suppressedFailureLogs = 0;
  private lastFailureAt: string | undefined;
  private heartbeatPublishPending = false;
  private heartbeatPublishPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mutator: BalanceMutator,
    private readonly stream: Redis,
    private readonly publisher: Redis,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    try {
      await this.stream.xgroup("CREATE", STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT, "0", "MKSTREAM");
    } catch (error) {
      if (!String(error).includes("BUSYGROUP")) throw error;
    }

    await this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.publishHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.streamTrimTimer = setInterval(
      () => void this.trimAcknowledgedEvents(),
      STREAM_RETENTION.TRIM_INTERVAL_MS,
    );
    void this.trimAcknowledgedEvents();
    console.log(`[settlement] consuming ${STREAMS.TRADES} as ${CONSUMER_GROUPS.SETTLEMENT}/settlement-${process.pid}`);
    await this.loop();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.streamTrimTimer) clearInterval(this.streamTrimTimer);
    await this.heartbeatPublishPromise;
    await this.publisher
      .eval(
        CLEAR_HEARTBEAT_IF_OWNER,
        2,
        KEYS.heartbeat(WORKERS.SETTLEMENT),
        KEYS.workerHealth(WORKERS.SETTLEMENT),
        this.heartbeatToken,
      )
      .catch((error) => console.warn("[settlement] heartbeat clear failed", error));
  }

  private async publishHeartbeat(): Promise<void> {
    if (!this.running) return;
    this.heartbeatPublishPending = true;
    if (!this.heartbeatPublishPromise) {
      this.heartbeatPublishPromise = this.flushHeartbeat();
    }
    await this.heartbeatPublishPromise;
  }

  /** The database outbox remains durable; prune only the already ACKed bus tail. */
  private async trimAcknowledgedEvents(): Promise<void> {
    if (!this.running) return;
    try {
      await trimAcknowledgedStream(this.publisher, STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT);
    } catch (error) {
      // Retention is an optimisation. Keeping extra history is safer than
      // allowing a transient Redis command failure to interrupt settlement.
      console.warn("[settlement] acknowledged trade stream trim deferred", error);
    }
  }

  /** Coalesces rapid failure updates and prevents a shutdown/publish race. */
  private async flushHeartbeat(): Promise<void> {
    while (this.running && this.heartbeatPublishPending) {
      this.heartbeatPublishPending = false;
      try {
        await this.publisher.eval(
          PUBLISH_HEARTBEAT,
          2,
          KEYS.heartbeat(WORKERS.SETTLEMENT),
          KEYS.workerHealth(WORKERS.SETTLEMENT),
          this.heartbeatToken,
          JSON.stringify({
            state: this.retainedEventIds.size > 0 ? "degraded" : "up",
            retainedEventCount: this.retainedEventIds.size,
            lastFailureAt: this.lastFailureAt,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          }),
          String(HEARTBEAT_TTL_SECONDS),
        );
      } catch (error) {
        console.error("[settlement] heartbeat publish failed", error);
      }
    }

    this.heartbeatPublishPromise = undefined;
  }

  private async loop(): Promise<void> {
    const consumer = `settlement-${process.pid}`;
    let claimCursor = "0-0";
    let lastClaimAt = 0;

    while (this.running) {
      if (Date.now() - lastClaimAt >= CLAIM_INTERVAL_MS) {
        try {
          const claimed = await this.reclaimPending(consumer, claimCursor);
          claimCursor = claimed.nextCursor;
          await this.processMessages(claimed.messages);
        } catch (error) {
          if (!this.running) return;
          console.error("[settlement] xautoclaim error, retrying", error);
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
      } catch (error) {
        if (!this.running) return;
        console.error("[settlement] xreadgroup error, retrying", error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      await this.processMessages(reply?.[0]?.[1] ?? []);
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

  private async processMessages(messages: StreamMessages): Promise<void> {
    for (const [id, fields] of messages) {
      // A shutdown completes the in-flight message but leaves the remainder
      // in the consumer group for a successor. This avoids disconnecting the
      // same Redis client between a successful transaction and its XACK.
      if (!this.running) return;
      let eventId = id;
      try {
        const payloadIndex = fields.indexOf("payload");
        const payload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;
        if (!payload) throw new Error("stream message has no payload");

        const event = JSON.parse(payload) as unknown;
        if (!isTradeStreamEvent(event)) throw new Error("invalid settlement stream payload");
        eventId = event.eventId;

        if (event.topic === "trade.executed") await this.settleTrade(event);
        else await this.closeOrder(event);

        await this.stream.xack(STREAMS.TRADES, CONSUMER_GROUPS.SETTLEMENT, id);
        if (this.retainedEventIds.delete(eventId)) void this.publishHeartbeat();
      } catch (error) {
        // Financial events are never ACKed after a failed parse or mutation.
        // XAUTOCLAIM will retain/replay them without bypassing idempotency.
        this.recordRetainedFailure(eventId, error);
      }
    }
  }

  /**
   * A corrupt or historically inconsistent PEL must remain recoverable, but
   * logging its stack trace every XAUTOCLAIM pass would drown out live events.
   * The health metadata remains degraded until every retained event succeeds.
   */
  private recordRetainedFailure(eventId: string, error: unknown): void {
    this.retainedEventIds.add(eventId);
    this.lastFailureAt = new Date().toISOString();
    void this.publishHeartbeat();

    const now = Date.now();
    if (now - this.failureLogWindowStartedAt >= RETAINED_FAILURE_LOG_WINDOW_MS) {
      if (this.suppressedFailureLogs > 0) {
        console.warn(
          `[settlement] ${this.suppressedFailureLogs} retained-event error logs were suppressed in the prior minute`,
        );
      }
      this.failureLogWindowStartedAt = now;
      this.failureLogsInWindow = 0;
      this.suppressedFailureLogs = 0;
    }

    if (this.failureLogsInWindow < RETAINED_FAILURE_LOG_LIMIT) {
      this.failureLogsInWindow += 1;
      console.error(`[settlement] event failed (retained for retry) ${eventId}`, error);
      return;
    }

    this.suppressedFailureLogs += 1;
    if (this.suppressedFailureLogs === 1) {
      console.warn("[settlement] additional retained-event error logs are suppressed for one minute; health is degraded");
    }
  }

  private async settleTrade(event: TradeExecutedEvent): Promise<void> {
    const cost = BigInt(event.price) * BigInt(event.qty);
    const parties = [...new Set([event.buyerAccountId, event.sellerAccountId])];

    const future = futureDef(event.symbol);
    const settled = await this.mutator.withAccountLock(parties, async (ctx) => {
      const duplicate = await ctx.tx.processedEvent.findUnique({ where: { eventId: event.eventId } });
      if (duplicate) return false;
      await ctx.tx.processedEvent.create({ data: { eventId: event.eventId } });

      const buyOrder = await ctx.tx.order.findUniqueOrThrow({ where: { id: event.buyOrderId } });
      const sellOrder = await ctx.tx.order.findUniqueOrThrow({ where: { id: event.sellOrderId } });
      if (future) {
        // 선물: 대금 대신 포지션·증거금·실현손익(모자라면 미수금). 같은 트랜잭션·같은 멱등 claim.
        await settleFuturesTrade(ctx, future, event, buyOrder, sellOrder);
        return true;
      }
      const holdConsumed = buyOrder.holdPerUnit * BigInt(event.qty);

      const deltas = new Map<string, { balance: bigint; hold: bigint }>();
      const addDelta = (accountId: string, balance: bigint, hold: bigint) => {
        const current = deltas.get(accountId) ?? { balance: 0n, hold: 0n };
        current.balance += balance;
        current.hold += hold;
        deltas.set(accountId, current);
      };
      addDelta(event.buyerAccountId, -cost, -holdConsumed);
      addDelta(event.sellerAccountId, cost, 0n);

      for (const [accountId, delta] of deltas) {
        const account = ctx.accounts[accountId];
        await ctx.updateAccount(accountId, {
          balance: account.balance + delta.balance,
          holdAmount: account.holdAmount + delta.hold,
        });
      }

      const runningBalances = new Map<string, bigint>(
        parties.map((accountId) => [accountId, ctx.accounts[accountId].balance]),
      );
      const ledger = (accountId: string, delta: bigint, reason: string) => {
        const balanceAfter = runningBalances.get(accountId)! + delta;
        runningBalances.set(accountId, balanceAfter);
        return ctx.tx.ledgerEntry.create({
          data: { accountId, delta, balanceAfter, reason, refId: event.tradeId },
        });
      };
      await ledger(event.buyerAccountId, -cost, "TRADE_BUY");
      await ledger(event.sellerAccountId, cost, "TRADE_SELL");

      await ctx.tx.holding.upsert({
        where: { accountId_symbol: { accountId: event.buyerAccountId, symbol: event.symbol } },
        update: { qty: { increment: event.qty }, costBasis: { increment: cost } },
        create: { accountId: event.buyerAccountId, symbol: event.symbol, qty: event.qty, costBasis: cost },
      });
      const sellerHolding = await ctx.tx.holding.findUniqueOrThrow({
        where: { accountId_symbol: { accountId: event.sellerAccountId, symbol: event.symbol } },
      });
      const sale = realizedPnlForSale(sellerHolding, event.qty, event.price);
      await ctx.tx.holding.update({
        where: { accountId_symbol: { accountId: event.sellerAccountId, symbol: event.symbol } },
        data: {
          qty: { decrement: event.qty },
          holdQty: { decrement: event.qty },
          costBasis: { decrement: sale.basisReduction },
        },
      });
      // 실현손익은 원가 차감과 같은 트랜잭션에 남긴다. tradeId unique가 재전달을 한 번 더 막는다.
      await ctx.tx.realizedPnl.create({
        data: {
          accountId: event.sellerAccountId,
          symbol: event.symbol,
          tradeId: event.tradeId,
          qty: event.qty,
          price: event.price,
          costBasis: sale.basisReduction,
          realized: sale.realized,
          tradedAt: new Date(event.ts),
        },
      });

      for (const order of [buyOrder, sellOrder]) {
        await ctx.tx.order.update({ where: { id: order.id }, data: stateAfterTrade(order, event.qty) });
      }
      return true;
    });

    if (settled) {
      // 체결 내용을 함께 실어 UI가 별도 조회 없이 알림을 띄울 수 있게 한다. 자기 체결이면 한 번만.
      const fill = { symbol: event.symbol, price: event.price, qty: event.qty, tradeId: event.tradeId };
      this.publishAccountUpdates([event.buyerAccountId], { type: "trade", side: "BUY", ...fill });
      if (event.sellerAccountId !== event.buyerAccountId) {
        this.publishAccountUpdates([event.sellerAccountId], { type: "trade", side: "SELL", ...fill });
      }
    }
    // Candles are rebuilt from durable trades, so a redelivery remains safe.
    await this.updateMarket(event);
  }

  private async closeOrder(event: OrderClosedEvent): Promise<void> {
    await this.mutator.withAccountLock([event.accountId], async (ctx) => {
      const duplicate = await ctx.tx.processedEvent.findUnique({ where: { eventId: event.eventId } });
      if (duplicate) return;

      const order = await ctx.tx.order.findUnique({ where: { id: event.orderId } });
      if (order && closeMustWaitForTrades(order, event)) {
        throw new Error(`order.closed is ahead of settled fills for ${event.orderId}: ${event.filledQty}/${order.filledQty}`);
      }

      await ctx.tx.processedEvent.create({ data: { eventId: event.eventId } });
      if (!order) return;
      const next = stateAfterClose(order, event);
      if (!next) return;

      await ctx.tx.order.update({
        where: { id: event.orderId },
        data: { status: next.status, filledQty: next.filledQty },
      });

      if (next.remainingQty <= 0) return;
      // 선물 주문은 매수·매도 모두 현금(증거금)을 묶는다 — 남은 수량만큼 풀어 준다.
      if (event.side === "BUY" || isFuture(event.symbol)) {
        const leftover = order.holdPerUnit * BigInt(next.remainingQty);
        if (leftover > 0n) {
          const account = ctx.accounts[event.accountId];
          await ctx.updateAccount(event.accountId, {
            balance: account.balance,
            holdAmount: account.holdAmount - leftover,
          });
        }
      } else {
        await ctx.tx.holding.update({
          where: { accountId_symbol: { accountId: event.accountId, symbol: event.symbol } },
          data: { holdQty: { decrement: next.remainingQty } },
        });
      }
    });

    this.publishAccountUpdates([event.accountId]);
  }

  private publishAccountUpdates(
    accountIds: string[],
    payload: Record<string, unknown> = { type: "account_update" },
  ): void {
    for (const accountId of new Set(accountIds)) {
      this.publisher.publish(CHANNELS.account(accountId), JSON.stringify(payload)).catch((error) => {
        // Pub/Sub invalidates UI caches only. Stream/database durability has
        // already completed, so a transient notification failure must not
        // replay financial state changes.
        console.error(`[settlement] account notification publish failed for ${accountId}`, error);
      });
    }
  }

  /**
   * 1분 봉을 그 분의 체결 원장 전체에서 다시 집계한다(재전달에도 거래량이 중복되지 않음).
   * 집계는 DB 안에서 한 문장으로 끝낸다 — 체결이 많은 분에 수백 행을 매번 Node로 끌어와
   * 줄이던 예전 방식은 체결 수에 비례해 DB·프로세스 CPU를 함께 태웠다.
   */
  private async updateMarket(event: TradeExecutedEvent): Promise<void> {
    const bucket = new Date(Math.floor(event.ts / 60_000) * 60_000);
    const bucketEnd = new Date(bucket.getTime() + 60_000);
    await this.prisma.$executeRaw`
      INSERT INTO market.candles (symbol, interval, ts, open, high, low, close, volume)
      SELECT
        ${event.symbol}, '1m', ${bucket},
        (array_agg(price ORDER BY created_at ASC, id ASC))[1],
        MAX(price),
        MIN(price),
        (array_agg(price ORDER BY created_at DESC, id DESC))[1],
        SUM(qty)::bigint
      FROM matching.trades
      WHERE symbol = ${event.symbol} AND created_at >= ${bucket} AND created_at < ${bucketEnd}
      HAVING COUNT(*) > 0
      ON CONFLICT (symbol, interval, ts) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        close = EXCLUDED.close, volume = EXCLUDED.volume
    `;
  }
}

async function main(): Promise<void> {
  const config = readSettlementRuntimeConfig();
  const prisma = getPrisma();
  const stream = new Redis(config.redisUrl);
  const publisher = new Redis(config.redisUrl);
  const mutator = createBalanceMutator(config.lockStrategy, prisma, publisher);
  const worker = new SettlementWorker(prisma, mutator, stream, publisher);
  let stopping = false;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[settlement] ${signal} received; stopping after the current event`);
    void worker.stop();
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    await worker.start();
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    await worker.stop();
    await Promise.allSettled([publisher.quit(), prisma.$disconnect()]);
  }
}

main().catch((error) => {
  console.error("[settlement] fatal", error);
  process.exitCode = 1;
});
