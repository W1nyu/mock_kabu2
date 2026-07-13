import { describe, expect, it, vi } from "vitest";
import { OrderController } from "../order.controller";

describe("OrderController.myOrders", () => {
  it("maps the optional symbol and status=live query without changing the default endpoint shape", () => {
    const myOrders = vi.fn();
    const controller = new OrderController({ myOrders } as never);

    controller.myOrders({ accountId: "account-1" } as never, "200", "KABU", "live");

    expect(myOrders).toHaveBeenCalledWith("account-1", 200, {
      symbol: "KABU",
      liveOnly: true,
    });
  });
});
