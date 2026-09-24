import { afterEach, describe, expect, it, vi } from "vitest";
import { kstSessionStartMs, onKstSessionOpen } from "../time";

afterEach(() => vi.useRealTimers());

describe("KST market session refresh", () => {
  it("refreshes at 09:00 KST and again after the first trade can arrive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T23:59:59.900Z"));
    const refresh = vi.fn();
    const stop = onKstSessionOpen(refresh);
    expect(kstSessionStartMs()).toBe(Date.parse("2026-09-22T00:00:00Z"));
    vi.advanceTimersByTime(201);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(kstSessionStartMs()).toBe(Date.parse("2026-09-23T00:00:00Z"));
    vi.advanceTimersByTime(4_900);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
