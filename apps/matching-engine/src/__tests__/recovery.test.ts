import { describe, expect, test } from "vitest";
import { MatchingEngine } from "../engine";
import { remainingRestingQty } from "../orderbook";

describe("matching engine restart recovery", () => {
  test("does not re-rest completed quantity when settlement's order row is stale", () => {
    expect(remainingRestingQty(15, 0, 15)).toBe(0);
  });

  test("uses the furthest-known fill count when replaying a partial limit order", () => {
    expect(remainingRestingQty(15, 2, 6)).toBe(9);
    expect(remainingRestingQty(15, 8, 6)).toBe(7);
  });

  test("bootstrap skips an OPEN row whose full quantity is already recorded as trades", async () => {
    const prisma = {
      marketSymbol: {
        findMany: async () => [{ symbol: "KABU", lastPrice: 100 }],
        update: async () => undefined,
      },
      order: {
        findMany: async () => [
          {
            id: "buy-1",
            accountId: "account-1",
            symbol: "KABU",
            side: "BUY",
            type: "LIMIT",
            price: 100,
            qty: 10,
            filledQty: 0,
            createdAt: new Date(),
          },
        ],
      },
      trade: {
        findFirst: async () => null,
        groupBy: async ({ by }: { by: string[] }) =>
          by[0] === "buyOrderId" ? [{ buyOrderId: "buy-1", _sum: { qty: 10 } }] : [],
      },
    };
    const engine = new MatchingEngine(prisma as any, {} as any, {} as any);

    await engine.bootstrap();

    const book = (engine as any).books.get("KABU");
    expect(book.bids).toEqual([]);
  });

  test("bootstrap restores the orderbook and last_price cache from the newest trade", async () => {
    const cacheRepairs: unknown[] = [];
    const prisma = {
      marketSymbol: {
        findMany: async () => [{ symbol: "KABU", lastPrice: 1000 }],
        update: async (args: unknown) => {
          cacheRepairs.push(args);
        },
      },
      order: { findMany: async () => [] },
      trade: {
        findFirst: async () => ({ price: 1300 }),
      },
    };
    const engine = new MatchingEngine(prisma as any, {} as any, {} as any);

    await engine.bootstrap();

    const book = (engine as any).books.get("KABU");
    expect(book.lastPrice).toBe(1300);
    expect(cacheRepairs).toEqual([
      { where: { symbol: "KABU" }, data: { lastPrice: 1300 } },
    ]);
  });

  test("bootstrap quarantines a later crossed legacy row without changing its durable order", async () => {
    const prisma = {
      marketSymbol: {
        findMany: async () => [{ symbol: "KABU", lastPrice: 100 }],
        update: async () => undefined,
      },
      order: {
        findMany: async () => [
          {
            id: "older-ask",
            accountId: "seller",
            symbol: "KABU",
            side: "SELL",
            type: "LIMIT",
            price: 100,
            qty: 10,
            filledQty: 0,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            id: "later-crossed-bid",
            accountId: "buyer",
            symbol: "KABU",
            side: "BUY",
            type: "LIMIT",
            price: 100,
            qty: 10,
            filledQty: 0,
            createdAt: new Date("2026-01-01T00:00:01.000Z"),
          },
        ],
      },
      trade: {
        findFirst: async () => null,
        groupBy: async () => [],
      },
    };
    const engine = new MatchingEngine(prisma as any, {} as any, {} as any);

    await engine.bootstrap();

    const book = (engine as any).books.get("KABU");
    expect(book.asks.map((order: { orderId: string }) => order.orderId)).toEqual(["older-ask"]);
    expect(book.bids).toEqual([]);
    // The test fake exposes no order update method: bootstrap's safety action
    // is strictly in-memory, not an implicit DB cleanup.
  });

  test("bootstrap gives a complete bot18 TANU reserve ladder priority over an older crossed legacy ask", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const reserveBids = [8670, 8660, 8650, 8640, 8630, 8620, 8610, 8600].map((price, index) => ({
      id: `reserve-bid-${index}`,
      accountId: "reserve-account",
      symbol: "TANU",
      side: "BUY",
      type: "LIMIT",
      price,
      qty: 160,
      filledQty: 0,
      createdAt: new Date(createdAt.getTime() + 1_000 + index),
    }));
    const reserveAsks = [8690, 8700, 8710, 8720, 8730, 8740, 8750, 8760].map((price, index) => ({
      id: `reserve-ask-${index}`,
      accountId: "reserve-account",
      symbol: "TANU",
      side: "SELL",
      type: "LIMIT",
      price,
      qty: 160,
      filledQty: 0,
      createdAt: new Date(createdAt.getTime() + 2_000 + index),
    }));
    const prisma = {
      marketSymbol: {
        findMany: async () => [{ symbol: "TANU", lastPrice: 8700 }],
        update: async () => undefined,
      },
      user: {
        findMany: async () => [{ id: "reserve-user", email: "bot18@bots.local" }],
      },
      account: {
        findMany: async () => [{ id: "reserve-account", userId: "reserve-user" }],
      },
      order: {
        findMany: async () => [
          {
            id: "older-legacy-ask",
            accountId: "legacy-seller",
            symbol: "TANU",
            side: "SELL",
            type: "LIMIT",
            price: 8580,
            qty: 10,
            filledQty: 0,
            createdAt,
          },
          ...reserveBids,
          ...reserveAsks,
        ],
      },
      trade: {
        findFirst: async () => null,
        groupBy: async () => [],
      },
    };
    const engine = new MatchingEngine(prisma as any, {} as any, {} as any);

    await engine.bootstrap();

    const book = (engine as any).books.get("TANU");
    expect(book.bids).toHaveLength(8);
    expect(book.asks).toHaveLength(8);
    expect(book.asks.some((order: { orderId: string }) => order.orderId === "older-legacy-ask")).toBe(false);
    expect(Math.max(...book.bids.map((order: { price: number }) => order.price))).toBeLessThan(
      Math.min(...book.asks.map((order: { price: number }) => order.price)),
    );
  });

  test("claims event id with the trade and last_price in the same transaction", async () => {
    const txCalls: string[] = [];
    const tx = {
      $queryRaw: async () => {
        txCalls.push("event.claim");
        return [{ event_id: "event-1" }];
      },
      trade: {
        create: async () => {
          txCalls.push("trade.create");
        },
      },
      marketSymbol: {
        update: async () => {
          txCalls.push("marketSymbol.update");
        },
      },
      matchingOutboxEvent: {
        create: async () => {
          txCalls.push("outbox.create");
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const redis = { xadd: async () => undefined };
    const publisher = { publish: async () => undefined };
    const engine = new MatchingEngine(prisma as any, redis as any, publisher as any);

    const persisted = await (engine as any).persistPlacedEvent(
      {
        topic: "order.placed",
        eventId: "event-1",
        orderId: "buy-1",
        accountId: "buyer",
        symbol: "KABU",
        side: "BUY",
        type: "LIMIT",
        price: 1300,
        qty: 3,
        ts: 0,
      },
      { symbol: "KABU" },
      {
        fills: [
          {
            price: 1300,
            qty: 3,
            makerOrderId: "sell-1",
            makerAccountId: "seller",
            takerOrderId: "buy-1",
            takerAccountId: "buyer",
            takerSide: "BUY",
          },
        ],
        restingQty: 0,
        canceledQty: 0,
        closedOrders: [],
      },
    );

    expect(persisted.applied).toBe(true);
    expect(txCalls).toEqual(["event.claim", "trade.create", "marketSymbol.update", "outbox.create"]);
  });

  test("does not rematch a duplicate eventId delivered as a new stream message after restart", async () => {
    const claimedEventIds = new Set<string>();
    const createdTrades: unknown[] = [];
    const outboxRows: { id: bigint; eventId: string; payload: unknown; publishedAt: Date | null }[] = [];
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const eventId = values[0] as string;
        if (claimedEventIds.has(eventId)) return [];
        claimedEventIds.add(eventId);
        return [{ event_id: eventId }];
      },
      trade: {
        create: async (args: unknown) => {
          createdTrades.push(args);
        },
      },
      marketSymbol: { update: async () => undefined },
      matchingOutboxEvent: {
        create: async ({ data }: any) => {
          outboxRows.push({
            id: BigInt(outboxRows.length + 1),
            eventId: data.eventId,
            payload: data.payload,
            publishedAt: null,
          });
        },
      },
    };
    const prisma = {
      order: {
        // Keep the order row OPEN and hide trade history to prove that the
        // durable event-id claim — not the legacy fallback — rejects the retry.
        findUnique: async () => ({ status: "OPEN" }),
      },
      trade: { findFirst: async () => null },
      matchingOutboxEvent: {
        findMany: async () => outboxRows.filter((row) => row.publishedAt == null),
        updateMany: async ({ where, data }: any) => {
          const row = outboxRows.find((candidate) => candidate.id === where.id && candidate.publishedAt == null);
          if (row) row.publishedAt = data.publishedAt;
          return { count: row ? 1 : 0 };
        },
      },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const redis = { xadd: async () => undefined };
    const publisher = { publish: async () => undefined, set: async () => undefined };
    const event = {
      topic: "order.placed" as const,
      eventId: "duplicated-outbox-event",
      orderId: "buy-1",
      accountId: "buyer",
      symbol: "KABU",
      side: "BUY" as const,
      type: "MARKET" as const,
      price: null,
      qty: 5,
      ts: 0,
    };
    const book = {
      symbol: "KABU",
      bids: [],
      asks: [
        {
          orderId: "sell-1",
          accountId: "seller",
          side: "SELL" as const,
          price: 100,
          qty: 5,
          totalQty: 5,
          seq: 1,
        },
      ],
      lastPrice: 100,
      seq: 1,
    };

    const firstEngine = new MatchingEngine(prisma as any, redis as any, publisher as any);
    (firstEngine as any).books.set("KABU", structuredClone(book));
    await firstEngine.handleEvent(event);

    // The same outbox event can be XADDed again after an API/outbox restart.
    // A fresh engine instance models a new Redis stream message after restart;
    // no redelivery flag is passed to handleEvent.
    const restartedEngine = new MatchingEngine(prisma as any, redis as any, publisher as any);
    (restartedEngine as any).books.set("KABU", structuredClone(book));
    await restartedEngine.handleEvent(event);

    expect(createdTrades).toHaveLength(1);
    expect(claimedEventIds).toEqual(new Set([event.eventId]));
    expect((restartedEngine as any).books.get("KABU").asks[0].qty).toBe(5);
    expect(outboxRows).toHaveLength(3);
    expect(outboxRows.every((row) => row.publishedAt != null)).toBe(true);
  });

  test("retries a committed trade outbox row with the same event id after XADD fails", async () => {
    const claimedEventIds = new Set<string>();
    const createdTrades: unknown[] = [];
    const outboxRows: { id: bigint; eventId: string; payload: unknown; publishedAt: Date | null }[] = [];
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const eventId = values[0] as string;
        if (claimedEventIds.has(eventId)) return [];
        claimedEventIds.add(eventId);
        return [{ event_id: eventId }];
      },
      trade: { create: async (args: unknown) => createdTrades.push(args) },
      marketSymbol: { update: async () => undefined },
      matchingOutboxEvent: {
        create: async ({ data }: any) => {
          outboxRows.push({
            id: BigInt(outboxRows.length + 1),
            eventId: data.eventId,
            payload: data.payload,
            publishedAt: null,
          });
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
      matchingOutboxEvent: {
        findMany: async () => outboxRows.filter((row) => row.publishedAt == null),
        updateMany: async ({ where, data }: any) => {
          const row = outboxRows.find((candidate) => candidate.id === where.id && candidate.publishedAt == null);
          if (row) row.publishedAt = data.publishedAt;
          return { count: row ? 1 : 0 };
        },
      },
    };
    const payloads: string[] = [];
    let attempts = 0;
    const redis = {
      xadd: async (_stream: string, _id: string, _field: string, payload: string) => {
        attempts++;
        payloads.push(payload);
        if (attempts === 1) throw new Error("Redis temporarily unavailable");
      },
    };
    const publisher = { publish: async () => undefined };
    const engine = new MatchingEngine(prisma as any, redis as any, publisher as any);

    const persisted = await (engine as any).persistPlacedEvent(
      {
        topic: "order.placed",
        eventId: "trade-event-1",
        orderId: "buy-1",
        accountId: "buyer",
        symbol: "KABU",
        side: "BUY",
        type: "LIMIT",
        price: 100,
        qty: 2,
        ts: 0,
      },
      { symbol: "KABU" },
      {
        fills: [
          {
            price: 100,
            qty: 2,
            makerOrderId: "sell-1",
            makerAccountId: "seller",
            takerOrderId: "buy-1",
            takerAccountId: "buyer",
            takerSide: "BUY",
          },
        ],
        restingQty: 0,
        canceledQty: 0,
        closedOrders: [],
      },
    );

    expect(persisted.applied).toBe(true);
    expect(createdTrades).toHaveLength(1);
    await expect(engine.flushSettlementOutbox()).rejects.toThrow("Redis temporarily unavailable");
    expect(outboxRows[0].publishedAt).toBeNull();

    await engine.flushSettlementOutbox();
    expect(outboxRows[0].publishedAt).not.toBeNull();
    expect(JSON.parse(payloads[0]).eventId).toBe(JSON.parse(payloads[1]).eventId);
    expect(createdTrades).toHaveLength(1);
  });

  test("keeps one durable cancellation event when its first relay attempt fails", async () => {
    let closePublishAttempts = 0;
    const publishedPayloads: string[] = [];
    const claimedEventIds = new Set<string>();
    const outboxRows: { id: bigint; eventId: string; payload: unknown; publishedAt: Date | null }[] = [];
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const eventId = values[0] as string;
        if (claimedEventIds.has(eventId)) return [];
        claimedEventIds.add(eventId);
        return [{ event_id: eventId }];
      },
      matchingOutboxEvent: {
        create: async ({ data }: any) => {
          outboxRows.push({
            id: BigInt(outboxRows.length + 1),
            eventId: data.eventId,
            payload: data.payload,
            publishedAt: null,
          });
        },
      },
    };
    const prisma = {
      order: { findUnique: async () => ({ status: "OPEN" }) },
      matchingOutboxEvent: {
        findMany: async () => outboxRows.filter((row) => row.publishedAt == null),
        updateMany: async ({ where, data }: any) => {
          const row = outboxRows.find((candidate) => candidate.id === where.id && candidate.publishedAt == null);
          if (row) row.publishedAt = data.publishedAt;
          return { count: row ? 1 : 0 };
        },
      },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const redis = {
      xadd: async (_stream: string, _id: string, _field: string, payload: string) => {
        closePublishAttempts++;
        publishedPayloads.push(payload);
        if (closePublishAttempts === 1) throw new Error("Redis temporarily unavailable");
      },
    };
    const publisher = { publish: async () => undefined, set: async () => undefined };
    const engine = new MatchingEngine(prisma as any, redis as any, publisher as any);
    (engine as any).books.set("KABU", {
      symbol: "KABU",
      bids: [
        {
          orderId: "buy-1",
          accountId: "buyer",
          side: "BUY",
          price: 100,
          qty: 5,
          totalQty: 5,
          seq: 1,
        },
      ],
      asks: [],
      lastPrice: 100,
      seq: 1,
    });
    const cancel = {
      topic: "order.cancel.requested" as const,
      eventId: "cancel-event-1",
      orderId: "buy-1",
      symbol: "KABU",
      ts: 0,
    };

    await engine.handleEvent(cancel);
    expect((engine as any).books.get("KABU").bids).toEqual([]);
    expect(outboxRows[0].publishedAt).toBeNull();

    await engine.flushSettlementOutbox();
    expect(closePublishAttempts).toBe(2);
    expect(outboxRows[0].publishedAt).not.toBeNull();
    expect(JSON.parse(publishedPayloads[0]).eventId).toBe(JSON.parse(publishedPayloads[1]).eventId);
  });
});
