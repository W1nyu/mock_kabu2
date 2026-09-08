import { describe, expect, test, vi } from "vitest";
import { RedisLeaderLease } from "../leader-lease";

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const hasNx = args.includes("NX");
      if (hasNx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (script: string, _keyCount: number, key: string, token: string) => {
      if (values.get(key) !== token) return 0;
      if (script.includes("PEXPIRE")) return 1;
      values.delete(key);
      return 1;
    }),
  };
}

describe("RedisLeaderLease", () => {
  test("only one token acquires a lease and the loser never considers itself leader", async () => {
    const redis = fakeRedis();
    const first = new RedisLeaderLease(redis as never, "lease:matching", 15_000, "leader-a");
    const second = new RedisLeaderLease(redis as never, "lease:matching", 15_000, "leader-b");

    await expect(first.acquire()).resolves.toBe(true);
    await expect(second.acquire()).resolves.toBe(false);
    expect(first.isHeld).toBe(true);
    expect(second.isHeld).toBe(false);
  });

  test("a stale token cannot renew or release a newer leader lease", async () => {
    const redis = fakeRedis();
    const oldLeader = new RedisLeaderLease(redis as never, "lease:matching", 15_000, "leader-old");
    await oldLeader.acquire();

    // Model expiry followed by a standby taking over before the old process
    // discovers its renewal failure.
    redis.values.set("lease:matching", "leader-new");

    await expect(oldLeader.renew()).resolves.toBe(false);
    expect(oldLeader.isHeld).toBe(false);
    await expect(oldLeader.release()).resolves.toBe(false);
    expect(redis.values.get("lease:matching")).toBe("leader-new");
  });

  test("release deletes only its own live lease", async () => {
    const redis = fakeRedis();
    const lease = new RedisLeaderLease(redis as never, "lease:matching", 15_000, "leader-a");
    await lease.acquire();

    await expect(lease.release()).resolves.toBe(true);
    expect(redis.values.has("lease:matching")).toBe(false);
    expect(lease.isHeld).toBe(false);
  });
});
