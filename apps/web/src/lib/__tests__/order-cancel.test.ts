import { describe, expect, it } from "vitest";
import { CANCEL_PENDING_MS, prunePendingCancels } from "../order-cancel";

describe("prunePendingCancels", () => {
  it("drops orders that left the open list and keeps the rest", () => {
    const pending = { a: 1_000, b: 1_000 };
    expect(prunePendingCancels(pending, new Set(["a"]), 2_000)).toEqual({ a: 1_000 });
  });

  it("re-enables the button once the API's 30s duplicate window has passed", () => {
    const pending = { a: 0, b: 10_000 };
    expect(prunePendingCancels(pending, null, CANCEL_PENDING_MS)).toEqual({ b: 10_000 });
  });

  it("returns the same object when nothing changed, so React skips the render", () => {
    const pending = { a: 1_000 };
    expect(prunePendingCancels(pending, new Set(["a"]), 2_000)).toBe(pending);
  });
});
