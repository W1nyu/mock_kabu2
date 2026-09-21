import { describe, expect, test } from "vitest";
import { drawdownOf } from "../drawdown";

describe("drawdownOf", () => {
  test("needs at least two points", () => {
    expect(drawdownOf([])).toBeNull();
    expect(drawdownOf([{ equity: 100 }])).toBeNull();
  });

  test("measures the deepest peak-to-trough fall, not the first one", () => {
    const dd = drawdownOf([100, 90, 120, 60, 130, 117].map((equity) => ({ equity })));
    expect(dd?.peak).toBe(130);
    expect(dd?.maxDrawdown).toBeCloseTo(0.5); // 120 → 60
    expect(dd?.current).toBeCloseTo(0.1); // 130 → 117
  });

  test("is zero while the curve only rises", () => {
    const dd = drawdownOf([100, 110, 120].map((equity) => ({ equity })));
    expect(dd).toEqual({ maxDrawdown: 0, peak: 120, current: 0 });
  });
});
