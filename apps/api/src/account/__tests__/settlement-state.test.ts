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

  test("keeps terminal close-first state from double-counting a later trade event", () => {
    expect(stateAfterTrade({ status: "FILLED", qty: 10, filledQty: 10 }, 5)).toEqual({
      status: "FILLED",
      filledQty: 10,
    });
  });

  test("rejects an overfill while the order is active", () => {
    expect(() => stateAfterTrade({ status: "PARTIAL", qty: 10, filledQty: 8 }, 3)).toThrow(
      "overfill detected",
    );
  });
});
