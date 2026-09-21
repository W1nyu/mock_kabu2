import { describe, expect, it, vi } from "vitest";
import { OrderController } from "../order.controller";

describe("OrderController.myOrders", () => {
  it("maps the optional symbol and status=live query without changing the default endpoint shape", () => {
    const myOrders = vi.fn();
    const controller = new OrderController({ myOrders } as never, {} as never);

    controller.myOrders({ accountId: "account-1" } as never, "200", "KABU", "live");

    expect(myOrders).toHaveBeenCalledWith("account-1", 200, {
      symbol: "KABU",
      liveOnly: true,
    });
  });

  it("attaches a bracket intent only after the buy order is accepted", async () => {
    const place = vi.fn().mockResolvedValue({ id: "order-1", symbol: "KABU" });
    const attach = vi.fn().mockResolvedValue({ id: "intent-1", status: "PENDING" });
    const controller = new OrderController({ place } as never, { attach } as never);

    const result = await controller.place({ accountId: "account-1" } as never, {
      symbol: "KABU",
      side: "BUY",
      type: "MARKET",
      qty: 3,
      bracket: { stopBps: 500, takeBps: 1_000 },
    });

    expect(attach).toHaveBeenCalledWith("account-1", "order-1", "KABU", { stopBps: 500, takeBps: 1_000 });
    expect(result).toMatchObject({ id: "order-1", bracket: { id: "intent-1" } });
  });

  it("rejects a bracket on a sell order before placing anything", async () => {
    const place = vi.fn();
    const controller = new OrderController({ place } as never, { attach: vi.fn() } as never);

    await expect(
      controller.place({ accountId: "account-1" } as never, {
        symbol: "KABU",
        side: "SELL",
        type: "MARKET",
        qty: 3,
        bracket: { stopBps: 500, takeBps: 1_000 },
      }),
    ).rejects.toThrow(/매수 주문에만/);
    expect(place).not.toHaveBeenCalled();
  });
});
