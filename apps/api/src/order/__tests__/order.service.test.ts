import { describe, expect, it, vi } from "vitest";
import { OrderService } from "../order.service";

describe("OrderService.myOrders", () => {
  it("keeps the existing account-wide query when no optional filter is supplied", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never, {} as never);

    await service.myOrders("account-1", 50);

    expect(findMany).toHaveBeenCalledWith({
      where: { accountId: "account-1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("filters a bot reconciliation query to one account-owned symbol and live statuses", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never, {} as never);

    await service.myOrders("account-1", 500, { symbol: " KABU ", liveOnly: true });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        accountId: "account-1",
        symbol: "KABU",
        status: { in: ["OPEN", "PARTIAL"] },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });
});

describe("OrderService.place tick-size validation", () => {
  it("rejects a limit price off the symbol's tick grid before touching the database", async () => {
    const findUnique = vi.fn();
    const service = new OrderService(
      { marketSymbol: { findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.place("account-1", { symbol: "TANU", side: "BUY", type: "LIMIT", price: 7_775, qty: 1 }),
    ).rejects.toThrow(/호가 단위는 10원/);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("OrderService.amend", () => {
  function liveOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "order-1",
      accountId: "account-1",
      symbol: "TANU",
      side: "BUY",
      type: "LIMIT",
      price: 7_000,
      qty: 10,
      filledQty: 2,
      status: "PARTIAL",
      ...overrides,
    };
  }

  it("does not place a replacement when the order fills before the cancel lands", async () => {
    const states = [liveOrder(), liveOrder({ status: "FILLED", filledQty: 10 })];
    const prisma = { order: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? liveOrder({ status: "FILLED", filledQty: 10 }))) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    const cancel = vi.spyOn(service, "cancel").mockResolvedValue({ ok: true });
    const place = vi.spyOn(service, "place").mockResolvedValue({ id: "new" } as never);

    const result = await service.amend("account-1", "order-1", { price: 7_010 });

    expect(cancel).toHaveBeenCalledWith("account-1", "order-1");
    expect(place).not.toHaveBeenCalled();
    expect(result.amended).toBe(false);
  });

  it("re-places at most the quantity still unfilled after the cancel", async () => {
    const states = [liveOrder(), liveOrder({ status: "CANCELED", filledQty: 5 })];
    const prisma = { order: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? liveOrder({ status: "CANCELED", filledQty: 5 }))) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    vi.spyOn(service, "cancel").mockResolvedValue({ ok: true });
    const place = vi.spyOn(service, "place").mockResolvedValue({ id: "new" } as never);

    const result = await service.amend("account-1", "order-1", { price: 7_010, qty: 8 });

    // 요청은 8주지만 취소 확인 시점의 미체결은 5주뿐이다.
    expect(place).toHaveBeenCalledWith("account-1", { symbol: "TANU", side: "BUY", type: "LIMIT", price: 7_010, qty: 5 });
    expect(result.amended).toBe(true);
  });

  it("rejects an amend that changes nothing or breaks the tick grid", async () => {
    const prisma = { order: { findUnique: vi.fn().mockResolvedValue(liveOrder()) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.amend("account-1", "order-1", { price: 7_000, qty: 8 })).rejects.toThrow(/바뀐 내용/);
    await expect(service.amend("account-1", "order-1", { price: 7_005 })).rejects.toThrow(/호가 단위/);
  });
});
