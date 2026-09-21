import { describe, expect, test } from "vitest";
import { closeMustWaitForTrades, realizedPnlForSale, stateAfterClose, stateAfterTrade } from "@mock-kabu/shared";

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

describe("realized pnl for a sale", () => {
  test("reduces cost basis proportionally and realizes the difference", () => {
    // 10주를 총 10,000원에 보유(평단 1,000) → 4주를 1,200원에 매도
    expect(realizedPnlForSale({ qty: 10, costBasis: 10_000n }, 4, 1_200)).toEqual({
      basisReduction: 4_000n,
      proceeds: 4_800n,
      realized: 800n,
    });
  });

  test("floors the basis reduction so the final sale zeroes the basis exactly", () => {
    // 3주를 1,000원에 보유 → 평단 333.33… 매도마다 내림하되 마지막 매도가 정확히 0으로 만든다
    const first = realizedPnlForSale({ qty: 3, costBasis: 1_000n }, 1, 400);
    expect(first.basisReduction).toBe(333n);
    const second = realizedPnlForSale({ qty: 2, costBasis: 1_000n - 333n }, 1, 400);
    expect(second.basisReduction).toBe(333n);
    const last = realizedPnlForSale({ qty: 1, costBasis: 1_000n - 666n }, 1, 400);
    expect(last.basisReduction).toBe(334n);
    expect(first.realized + second.realized + last.realized).toBe(200n);
  });

  test("treats a sale from an empty holding as pure proceeds", () => {
    expect(realizedPnlForSale({ qty: 0, costBasis: 0n }, 2, 500)).toEqual({
      basisReduction: 0n,
      proceeds: 1_000n,
      realized: 1_000n,
    });
  });

  test("realizes a loss when the sale price is below the average cost", () => {
    expect(realizedPnlForSale({ qty: 5, costBasis: 5_000n }, 5, 900).realized).toBe(-500n);
  });
});
