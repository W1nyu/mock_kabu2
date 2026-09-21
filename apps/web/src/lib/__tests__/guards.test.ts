import { describe, expect, test } from "vitest";
import type { ConditionalOrderDto } from "@mock-kabu/shared";
import { guardSummary } from "../guards";

function row(overrides: Partial<ConditionalOrderDto>): ConditionalOrderDto {
  return {
    id: "x",
    symbol: "KABU",
    side: "SELL",
    direction: "AT_OR_BELOW",
    triggerPrice: 1_000,
    qty: 1,
    orderType: "MARKET",
    limitPrice: null,
    ocoGroupId: null,
    trailBps: null,
    watermark: null,
    status: "WAITING",
    triggeredOrderId: null,
    triggerTradePrice: null,
    failReason: null,
    triggeredAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("guardSummary", () => {
  test("picks the nearest stop and take-profit and lists trailing stops", () => {
    const text = guardSummary([
      row({ triggerPrice: 900 }),
      row({ triggerPrice: 950 }),
      row({ direction: "AT_OR_ABOVE", triggerPrice: 1_200 }),
      row({ direction: "AT_OR_ABOVE", triggerPrice: 1_100 }),
      row({ trailBps: 250, triggerPrice: 975, watermark: 1_000 }),
    ]);
    expect(text).toBe("손절 950 · 익절 1,100 · 트레일링 2.5% (현재 975)");
  });

  test("formats whole-percent trailing distances without a decimal", () => {
    expect(guardSummary([row({ trailBps: 300, triggerPrice: 970 })])).toBe("트레일링 3% (현재 970)");
  });

  test("is empty without rows", () => {
    expect(guardSummary([])).toBe("");
  });
});
