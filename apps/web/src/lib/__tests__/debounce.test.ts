import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { debounce } from "../debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("collapses a burst into one trailing call with the last arguments", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    vi.advanceTimersByTime(50);
    d(3);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  test("cancel drops the pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
