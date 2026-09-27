import { afterEach, describe, expect, it, vi } from "vitest";
import { createTickBatcher } from "../tick-batch";

describe("createTickBatcher", () => {
  afterEach(() => vi.useRealTimers());

  it("applies everything pushed within the interval in one call", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const batcher = createTickBatcher<number>(apply, 200);
    batcher.push(1);
    batcher.push(2);
    vi.advanceTimersByTime(199);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledWith([1, 2]);
    batcher.push(3);
    vi.advanceTimersByTime(200);
    expect(apply).toHaveBeenLastCalledWith([3]);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("drops pending items on cancel", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const batcher = createTickBatcher<number>(apply, 200);
    batcher.push(1);
    batcher.cancel();
    vi.advanceTimersByTime(500);
    expect(apply).not.toHaveBeenCalled();
  });
});
