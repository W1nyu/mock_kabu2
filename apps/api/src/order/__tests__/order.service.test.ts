import { describe, expect, it, vi } from "vitest";
import { OrderService } from "../order.service";

describe("OrderService.myOrders", () => {
  it("keeps the existing account-wide query when no optional filter is supplied", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never);

    await service.myOrders("account-1", 50);

    expect(findMany).toHaveBeenCalledWith({
      where: { accountId: "account-1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("filters a bot reconciliation query to one account-owned symbol and live statuses", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never);

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
