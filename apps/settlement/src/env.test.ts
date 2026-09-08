import { describe, expect, it } from "vitest";
import { readSettlementRuntimeConfig } from "./env";

describe("readSettlementRuntimeConfig", () => {
  it("reads a standalone worker's Redis and locking configuration", () => {
    expect(
      readSettlementRuntimeConfig({
        REDIS_URL: "redis://cache.example.test:6379/2",
        LOCK_STRATEGY: "optimistic",
      }),
    ).toEqual({ redisUrl: "redis://cache.example.test:6379/2", lockStrategy: "optimistic" });
  });

  it("fails before consuming a stream with an invalid endpoint or lock strategy", () => {
    expect(() => readSettlementRuntimeConfig({ REDIS_URL: "http://cache.example.test" })).toThrow("REDIS_URL");
    expect(() => readSettlementRuntimeConfig({ LOCK_STRATEGY: "unsafe" })).toThrow("LOCK_STRATEGY");
  });
});
