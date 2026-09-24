import { describe, expect, it } from "vitest";
import { averageAt } from "../moving-average";

const candles = [
  { close: 10, volume: 1 },
  { close: 20, volume: 2 },
  { close: 30, volume: 3 },
  { close: 10, volume: 4 },
];

describe("moving averages", () => {
  it("waits for a full window and calculates all four kinds", () => {
    expect(averageAt(candles, 1, 3, "SMA")).toBeNull();
    expect(averageAt(candles, 2, 3, "SMA")).toBe(20);
    expect(averageAt(candles, 3, 3, "EMA")).toBe(15);
    expect(averageAt(candles, 2, 3, "WMA")).toBeCloseTo(140 / 6);
    expect(averageAt(candles, 2, 3, "VWMA")).toBeCloseTo(140 / 6);
    expect(averageAt(candles, 3, 3, "VWMA")).toBeCloseTo(170 / 9);
  });

  it("does not draw a VWMA when the entire window has zero volume", () => {
    expect(averageAt([{ close: 10, volume: 0 }], 0, 1, "VWMA")).toBeNull();
  });
});
