import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderController } from "../order.controller";
import { ConditionalOrderController } from "../conditional-order.controller";

afterEach(() => vi.useRealTimers());

describe("maintenance order gate", () => {
  it("rejects new, amended, and conditional orders before a write is attempted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T19:15:00Z"));
    const place = vi.fn();
    const amend = vi.fn();
    const conditionalPlace = vi.fn();
    const regular = new OrderController({ place, amend } as never, {} as never);
    const conditional = new ConditionalOrderController({ place: conditionalPlace } as never);
    const user = { accountId: "account-1" } as never;

    await expect(regular.place(user, { symbol: "KABU", side: "BUY", type: "MARKET", qty: 1 }))
      .rejects.toMatchObject({ status: 503 });
    expect(() => regular.amend(user, "order-1", { price: 1000 })).toThrow(/점검 시간/);
    expect(() => conditional.place(user, { symbol: "KABU", side: "SELL", qty: 1 })).toThrow(/점검 시간/);
    expect(place).not.toHaveBeenCalled();
    expect(amend).not.toHaveBeenCalled();
    expect(conditionalPlace).not.toHaveBeenCalled();
  });
});
