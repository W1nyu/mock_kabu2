import { describe, expect, it } from "vitest";
import { readApiRuntimeConfig } from "../runtime-config";

describe("readApiRuntimeConfig", () => {
  it("normalizes explicit API runtime configuration", () => {
    expect(
      readApiRuntimeConfig({
        API_PORT: "4200",
        REDIS_URL: "rediss://cache.example.test:6380/1",
        WEB_ORIGIN: "https://app.example.test, https://admin.example.test",
        LOCK_STRATEGY: "distributed",
      }),
    ).toEqual({
      apiPort: 4200,
      redisUrl: "rediss://cache.example.test:6380/1",
      webOrigins: ["https://app.example.test", "https://admin.example.test"],
      lockStrategy: "distributed",
    });
  });

  it("rejects ambiguous infrastructure configuration before Nest starts", () => {
    expect(() => readApiRuntimeConfig({ API_PORT: "0" })).toThrow("API_PORT");
    expect(() => readApiRuntimeConfig({ REDIS_URL: "https://redis.example.test" })).toThrow("REDIS_URL");
    expect(() => readApiRuntimeConfig({ WEB_ORIGIN: "https://app.example.test/path" })).toThrow("WEB_ORIGIN");
    expect(() => readApiRuntimeConfig({ LOCK_STRATEGY: "unsafe" })).toThrow("LOCK_STRATEGY");
  });
});
