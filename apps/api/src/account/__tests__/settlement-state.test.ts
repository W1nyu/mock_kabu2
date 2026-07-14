import { describe, expect, test } from "vitest";
import { closeMustWaitForTrades, stateAfterClose, stateAfterTrade } from "../settlement-state";

describe("settlement order state", () => {
  test("does not release a filled order for a stale cancellation event", () => {
    expect(
      stateAfterClose(
        { status: "FILLED", qty: 10, filledQty: 10 },
        { status: "CANCELED", filledQty: 0 },
      ),
    ).toBeNull();
  });

  test("does not move a partial order backwards for an older close event", () => {
    expect(
      stateAfterClose(
        { status: "PARTIAL", qty: 10, filledQty: 6 },
        { status: "CANCELED", filledQty: 4 },
      ),
    ).toBeNull();
  });

  test("defers a close until its preceding fills have settled", () => {
    expect(
      closeMustWaitForTrades(
        { status: "PARTIAL", qty: 24, filledQty: 16 },
        { filledQty: 21 },
      ),
    ).toBe(true);
    expect(
      closeMustWaitForTrades(
        { status: "PARTIAL", qty: 24, filledQty: 21 },
        { filledQty: 21 },
      ),
    ).toBe(false);
  });

  test("rejects a late trade after a terminal close so settlement rolls back", () => {
    expect(() => stateAfterTrade({ status: "FILLED", qty: 10, filledQty: 10 }, 5)).toThrow(
      "late trade targets terminal order",
    );
  });

  test("rejects an overfill while the order is active", () => {
    expect(() => stateAfterTrade({ status: "PARTIAL", qty: 10, filledQty: 8 }, 3)).toThrow(
      "overfill detected",
    );
  });
});
