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
});
