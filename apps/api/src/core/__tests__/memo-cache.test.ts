import { describe, expect, it, vi } from "vitest";
import { MemoCache } from "../memo-cache";

describe("MemoCache", () => {
  it("reuses a value inside the ttl and recomputes after it expires", async () => {
    vi.useFakeTimers();
    const cache = new MemoCache();
    const compute = vi.fn().mockResolvedValue(1).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.getOrCompute("k", 1_000, compute)).toBe(1);
    vi.advanceTimersByTime(500);
    expect(await cache.getOrCompute("k", 1_000, compute)).toBe(1);
    vi.advanceTimersByTime(600);
    expect(await cache.getOrCompute("k", 1_000, compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("shares one in-flight computation between concurrent callers", async () => {
    const cache = new MemoCache();
    let resolve!: (value: number) => void;
    const compute = vi.fn(() => new Promise<number>((r) => (resolve = r)));

    const a = cache.getOrCompute("k", 1_000, compute);
    const b = cache.getOrCompute("k", 1_000, compute);
    resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed computation", async () => {
    const cache = new MemoCache();
    const compute = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(3);
    await expect(cache.getOrCompute("k", 1_000, compute)).rejects.toThrow("db down");
    expect(await cache.getOrCompute("k", 1_000, compute)).toBe(3);
  });

  it("invalidates by prefix", async () => {
    const cache = new MemoCache();
    await cache.getOrCompute("leaderboard:all", 60_000, async () => "x");
    await cache.getOrCompute("summary:KABU", 60_000, async () => "y");
    cache.invalidate("leaderboard:");
    expect(cache.size).toBe(1);
  });
it("serves the stale value at once and refreshes in the background within staleMs", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoCache();
      let resolve!: (value: number) => void;
      const compute = vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(1)
        .mockImplementationOnce(() => new Promise<number>((r) => (resolve = r)));
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(1);

      vi.advanceTimersByTime(2_000);
      // 만료됐지만 stale 구간이라 기다리지 않고 이전 값, 갱신은 한 번만 시작된다.
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(1);
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(1);
      expect(compute).toHaveBeenCalledTimes(2);

      resolve(2);
      await vi.runAllTicks();
      await Promise.resolve();
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a fresh value once the stale window has passed", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoCache();
      const compute = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 });
      vi.advanceTimersByTime(7_000);
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the stale value when a background refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoCache();
      const compute = vi.fn<() => Promise<number>>().mockRejectedValue(new Error("db down")).mockResolvedValueOnce(1);
      await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 });
      vi.advanceTimersByTime(2_000);
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(await cache.getOrCompute("k", 1_000, compute, { staleMs: 5_000 })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
