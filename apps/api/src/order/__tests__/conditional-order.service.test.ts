import { UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ConditionalOrderService } from "../conditional-order.service";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function waitingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cond-1",
    accountId: "acct-1",
    symbol: "KABU",
    side: "SELL",
    direction: "AT_OR_BELOW",
    triggerPrice: 1_000,
    qty: 5,
    orderType: "MARKET",
    limitPrice: null,
    status: "WAITING",
    triggeredOrderId: null,
    triggerTradePrice: null,
    failReason: null,
    triggeredAt: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

function build(options: { rows?: ReturnType<typeof waitingRow>[]; claimCount?: number; placeError?: Error } = {}) {
  const prisma = {
    conditionalOrder: {
      findMany: vi.fn().mockResolvedValue(options.rows ?? [waitingRow()]),
      updateMany: vi.fn().mockResolvedValue({ count: options.claimCount ?? 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    marketSymbol: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const orders = {
    place: options.placeError
      ? vi.fn().mockRejectedValue(options.placeError)
      : vi.fn().mockResolvedValue({ id: "order-9" }),
  };
  const realtime = { notifyAccount: vi.fn() };
  const sub = { on: vi.fn(), off: vi.fn(), psubscribe: vi.fn().mockResolvedValue(1) };
  const service = new ConditionalOrderService(prisma as never, sub as never, orders as never, realtime as never);
  return { service, prisma, orders, realtime };
}

describe("ConditionalOrderService trigger loop", () => {
  it("ignores prints that do not satisfy the condition", async () => {
    const { service, prisma, orders } = build();
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_001);
    await flush();

    expect(prisma.conditionalOrder.updateMany).not.toHaveBeenCalled();
    expect(orders.place).not.toHaveBeenCalled();
  });

  it("claims the row once, places the market order, and records the order id", async () => {
    const { service, prisma, orders, realtime } = build();
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_000);
    // 같은 프로세스에서 곧바로 두 번째 체결이 와도 인덱스에서 이미 빠져 있다.
    service.onTick("KABU", 990);
    await flush();

    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "cond-1", status: "WAITING" },
      data: expect.objectContaining({ status: "TRIGGERED", triggerTradePrice: 1_000 }),
    });
    expect(orders.place).toHaveBeenCalledWith("acct-1", { symbol: "KABU", side: "SELL", type: "MARKET", qty: 5 });
    expect(prisma.conditionalOrder.update).toHaveBeenCalledWith({
      where: { id: "cond-1" },
      data: { triggeredOrderId: "order-9" },
    });
    expect(realtime.notifyAccount).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ type: "conditional", status: "TRIGGERED", orderId: "order-9" }),
    );
  });

  it("does not place an order when another instance already claimed the row", async () => {
    const { service, orders } = build({ claimCount: 0 });
    await (service as any).reloadIndex();

    service.onTick("KABU", 900);
    await flush();

    expect(orders.place).not.toHaveBeenCalled();
  });

  it("marks the row FAILED with the rejection reason when placement is refused", async () => {
    const { service, prisma, realtime } = build({
      placeError: new UnprocessableEntityException("매도 가능 수량이 부족합니다"),
    });
    await (service as any).reloadIndex();

    service.onTick("KABU", 900);
    await flush();

    expect(prisma.conditionalOrder.update).toHaveBeenCalledWith({
      where: { id: "cond-1" },
      data: { status: "FAILED", failReason: "매도 가능 수량이 부족합니다" },
    });
    expect(realtime.notifyAccount).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ status: "FAILED", failReason: "매도 가능 수량이 부족합니다" }),
    );
  });

  it("passes the limit price through for a LIMIT-at-trigger order", async () => {
    const { service, orders } = build({
      rows: [waitingRow({ side: "BUY", direction: "AT_OR_ABOVE", triggerPrice: 1_200, orderType: "LIMIT", limitPrice: 1_210 })],
    });
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_250);
    await flush();

    expect(orders.place).toHaveBeenCalledWith("acct-1", {
      symbol: "KABU",
      side: "BUY",
      type: "LIMIT",
      qty: 5,
      price: 1_210,
    });
  });
});
