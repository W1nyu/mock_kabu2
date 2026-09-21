import { describe, expect, test } from "vitest";
import { sparklineGeometry } from "../sparkline";

describe("sparklineGeometry", () => {
  test("maps min to the bottom and max to the top inside the padding", () => {
    const g = sparklineGeometry([1, 3, 2], 100, 30, 2);
    expect(g?.points).toBe("2.0,28.0 50.0,2.0 98.0,15.0");
    expect(g?.lastX).toBe(98);
    expect(g?.lastY).toBe(15);
  });

  test("draws a flat line for constant values instead of dividing by zero", () => {
    const g = sparklineGeometry([5, 5, 5], 100, 30);
    const ys = new Set(g?.points.split(" ").map((p) => p.split(",")[1]));
    expect(ys.size).toBe(1);
    expect([...ys][0]).not.toBe("NaN");
  });

  test("returns null for fewer than two points", () => {
    expect(sparklineGeometry([1], 100, 30)).toBeNull();
  });
});
