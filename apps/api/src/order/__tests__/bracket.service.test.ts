import { describe, expect, it, vi } from "vitest";
import { BracketService } from "../bracket.service";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent-1",
    accountId: "acct-1",
    orderId: "order-1",
    symbol: "KABU",
    stopBps: 500,
    takeBps: 1_000,
    status: "PENDING",
    armedQty: 0,
    avgFillPrice: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(options: {
  order: Record<string, unknown> | null;
  lastPrice: number;
  fill?: { qty: bigint; amount: bigint };
  intent?: Record<string, unknown>;
}) {
  const prisma = {
    bracketIntent: {
      findMany: vi.fn().mockResolvedValue([intent(options.intent)]),
      findUnique: vi.fn().mockResolvedValue(intent(options.intent)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    order: { findUnique: vi.fn().mockResolvedValue(options.order) },
    marketSymbol: { findUniqueOrThrow: vi.fn().mockResolvedValue({ symbol: "KABU", lastPrice: options.lastPrice }) },
    $queryRaw: vi.fn().mockResolvedValue([options.fill ?? { qty: 0n, amount: 0n }]),
  };
  const conditional = {
    placeOco: vi.fn().mockResolvedValue([{ ocoGroupId: "g1" }, { ocoGroupId: "g1" }]),
    place: vi.fn().mockResolvedValue({ id: "cond-1" }),
  };
  const orders = { place: vi.fn().mockResolvedValue({ id: "sell-1" }) };
  const realtime = { notifyAccount: vi.fn() };
  const service = new BracketService(prisma as never, conditional as never, orders as never, realtime as never);
  return { service, prisma, conditional, orders, realtime };
}

describe("BracketService.sweep", () => {
  it("leaves a still-open parent order alone", async () => {
    const { service, prisma, conditional } = build({ order: { id: "order-1", status: "OPEN", filledQty: 0 }, lastPrice: 10_000 });
    await service.sweep();
    expect(prisma.bracketIntent.updateMany).not.toHaveBeenCalled();
    expect(conditional.placeOco).not.toHaveBeenCalled();
  });

  it("arms an OCO at the average fill price once the buy is filled", async () => {
    const { service, conditional, prisma } = build({
      order: { id: "order-1", status: "FILLED", filledQty: 10 },
      lastPrice: 10_050,
      fill: { qty: 10n, amount: 100_000n }, // 평균 10,000
    });
    await service.sweep();

    expect(conditional.placeOco).toHaveBeenCalledWith("acct-1", {
      symbol: "KABU",
      side: "SELL",
      qty: 10,
      lowerPrice: 9_500,
      upperPrice: 11_000,
    });
    expect(prisma.bracketIntent.update).toHaveBeenCalledWith({
      where: { id: "intent-1" },
      data: expect.objectContaining({ armedQty: 10, avgFillPrice: 10_000 }),
    });
  });

  it("with only a stop-loss, arms a single sell trigger below the fill instead of an OCO", async () => {
    const { service, conditional } = build({
      order: { id: "order-1", status: "FILLED", filledQty: 10 },
      lastPrice: 10_050,
      fill: { qty: 10n, amount: 100_000n },
      intent: { takeBps: null },
    });
    await service.sweep();
    expect(conditional.placeOco).not.toHaveBeenCalled();
    expect(conditional.place).toHaveBeenCalledWith("acct-1", {
      symbol: "KABU", side: "SELL", direction: "AT_OR_BELOW", triggerPrice: 9_500, qty: 10, orderType: "MARKET",
    });
  });

  it("with only a take-profit, arms a single sell trigger above the fill", async () => {
    const { service, conditional } = build({
      order: { id: "order-1", status: "FILLED", filledQty: 10 },
      lastPrice: 10_050,
      fill: { qty: 10n, amount: 100_000n },
      intent: { stopBps: null },
    });
    await service.sweep();
    expect(conditional.place).toHaveBeenCalledWith("acct-1", expect.objectContaining({ direction: "AT_OR_ABOVE", triggerPrice: 11_000 }));
  });

  it("accepts one leg but rejects a bracket with neither", () => {
    expect(BracketService.validateSpec({ stopBps: 500 })).toEqual({ stopBps: 500, takeBps: null });
    expect(BracketService.validateSpec({ takeBps: 1_000, stopBps: null })).toEqual({ stopBps: null, takeBps: 1_000 });
    expect(() => BracketService.validateSpec({})).toThrow(/하나는/);
  });

  it("protects only the filled part of a partially filled, then canceled, order", async () => {
    const { service, conditional } = build({
      order: { id: "order-1", status: "CANCELED", filledQty: 4 },
      lastPrice: 10_050,
      fill: { qty: 4n, amount: 40_000n },
    });
    await service.sweep();
    expect(conditional.placeOco).toHaveBeenCalledWith("acct-1", expect.objectContaining({ qty: 4 }));
  });

  it("closes the intent when the order ended without any fill", async () => {
    const { service, prisma, conditional } = build({ order: { id: "order-1", status: "CANCELED", filledQty: 0 }, lastPrice: 10_000 });
    await service.sweep();
    expect(conditional.placeOco).not.toHaveBeenCalled();
    expect(prisma.bracketIntent.update).toHaveBeenCalledWith({
      where: { id: "intent-1" },
      data: { status: "CANCELED", note: "체결 없이 종결된 주문" },
    });
  });

  it("sells immediately instead of arming when the price already crossed the stop", async () => {
    const { service, conditional, orders } = build({
      order: { id: "order-1", status: "FILLED", filledQty: 10 },
      lastPrice: 9_400, // 손절선 9,500 아래
      fill: { qty: 10n, amount: 100_000n },
    });
    await service.sweep();
    expect(conditional.placeOco).not.toHaveBeenCalled();
    expect(orders.place).toHaveBeenCalledWith("acct-1", { symbol: "KABU", side: "SELL", type: "MARKET", qty: 10 });
  });
});
