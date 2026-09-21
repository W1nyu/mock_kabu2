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
