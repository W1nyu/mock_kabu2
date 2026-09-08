import { afterEach, describe, expect, test, vi } from "vitest";
import { parseOrderStreamMessages } from "../stream-parser";

afterEach(() => vi.restoreAllMocks());

describe("parseOrderStreamMessages", () => {
  test("retains malformed payloads while allowing later valid events through", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const valid = {
      topic: "order.placed",
      eventId: "event-2",
      orderId: "order-2",
      accountId: "account-2",
      symbol: "KABU",
      side: "BUY",
      type: "LIMIT",
      price: 100,
      qty: 1,
      ts: 1,
    };

    const messages = parseOrderStreamMessages([
      [
        "mock-kabu2:streams:orders",
        [
          ["1-0", ["payload", "{not-json"]],
          ["2-0", ["payload", "{}"]],
          ["3-0", ["payload", JSON.stringify(valid)]],
        ],
      ],
    ]);

    expect(messages).toEqual([{ id: "3-0", ev: valid }]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("1-0"), expect.any(SyntaxError));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("2-0"));
  });
});
