import { describe, expect, test, vi } from "vitest";
import { MatchingEngine } from "../engine";

type ActiveOrder = {
  id: string;
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  filledQty: number;
  status: "OPEN" | "PARTIAL";
};

function setup(order: ActiveOrder, recordedQty: number) {
  const xadd = vi.fn(async () => undefined);
  const claimedEventIds = new Set<string>();
  const outboxRows: { id: bigint; eventId: string; payload: unknown; publishedAt: Date | null }[] = [];
  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const eventId = values[0] as string;
      if (claimedEventIds.has(eventId)) return [];
      claimedEventIds.add(eventId);
      return [{ event_id: eventId }];
    }),
    matchingOutboxEvent: {
      create: vi.fn(async ({ data }: any) => {
        outboxRows.push({
          id: BigInt(outboxRows.length + 1),
          eventId: data.eventId,
          payload: data.payload,
          publishedAt: null,
        });
      }),
    },
  };
  const prisma = {
    order: { findUnique: vi.fn(async () => order) },
    trade: { aggregate: vi.fn(async () => ({ _sum: { qty: recordedQty } })) },
    matchingOutboxEvent: {
      findMany: vi.fn(async () => outboxRows.filter((row) => row.publishedAt == null)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = outboxRows.find((candidate) => candidate.id === where.id && candidate.publishedAt == null);
        if (row) row.publishedAt = data.publishedAt;
        return { count: row ? 1 : 0 };
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const publisher = { publish: vi.fn(async () => undefined), set: vi.fn(async () => undefined) };
  const engine = new MatchingEngine(prisma as never, { xadd } as never, publisher as never);
  (engine as any).books.set(order.symbol, {
    symbol: order.symbol,
    bids: [],
    asks: [],
    lastPrice: 100,
    seq: 0,
  });
  return { engine, xadd };
}

async function cancel(engine: MatchingEngine, order: ActiveOrder) {
  await engine.handleEvent({
    topic: "order.cancel.requested",
    eventId: `cancel-${order.id}`,
    orderId: order.id,
    symbol: order.symbol,
    ts: 0,
  });
}

function closePayload(xadd: { mock: { calls: unknown[][] } }) {
  const [, , , raw] = xadd.mock.calls[0] as [string, string, string, string];
  return JSON.parse(raw) as { status: string; filledQty: number; reason?: string; orderId: string };
}

describe("matching-engine orphaned cancel", () => {
  test("closes an OPEN order missing from the snapshot when no trade was recorded", async () => {
    const order: ActiveOrder = {
      id: "orphan-open",
      accountId: "account-1",
      symbol: "KABU",
      side: "BUY",
      qty: 10,
      filledQty: 0,
      status: "OPEN",
    };
    const { engine, xadd } = setup(order, 0);

    await cancel(engine, order);

    expect(xadd).toHaveBeenCalledTimes(1);
    expect(closePayload(xadd)).toMatchObject({
      orderId: order.id,
      status: "CANCELED",
      filledQty: 0,
      reason: "orphaned_book_cancel",
    });
  });

  test.each([
    { filledQty: 4, expectedStatus: "CANCELED" },
    { filledQty: 10, expectedStatus: "FILLED" },
  ])("uses matching DB fill state for a snapshot-missing PARTIAL order", async ({ filledQty, expectedStatus }) => {
    const order: ActiveOrder = {
      id: `orphan-partial-${filledQty}`,
      accountId: "account-1",
      symbol: "KABU",
      side: "SELL",
      qty: 10,
      filledQty,
      status: "PARTIAL",
    };
    const { engine, xadd } = setup(order, filledQty);

    await cancel(engine, order);

    expect(closePayload(xadd)).toMatchObject({ status: expectedStatus, filledQty });
  });

  test("refuses an orphan whose recorded fills disagree with settlement", async () => {
    const order: ActiveOrder = {
      id: "orphan-mismatch",
      accountId: "account-1",
      symbol: "KABU",
      side: "BUY",
      qty: 10,
      filledQty: 0,
      status: "OPEN",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { engine, xadd } = setup(order, 6);

    await cancel(engine, order);

    expect(xadd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("settlement mismatch"));
    warn.mockRestore();
  });
});
