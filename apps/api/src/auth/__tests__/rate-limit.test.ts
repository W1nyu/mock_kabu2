import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LoginRateLimitGuard, SignupRateLimitGuard, enforceRateLimit } from "../login-rate-limit.guard";

function redisWithCounter(start = 0) {
  let count = start;
  return {
    incr: vi.fn().mockImplementation(async () => ++count),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(42),
  };
}

const request = (body: Record<string, unknown> = {}, ip = "10.0.0.1") =>
  ({ body, ip, headers: {} }) as never;

describe("rate limit", () => {
  it("allows up to the limit and starts the window on the first attempt", async () => {
    const redis = redisWithCounter();
    for (let i = 0; i < 10; i += 1) {
      await enforceRateLimit(redis as never, LoginRateLimitGuard.rule, request({ email: "A@x.io" }));
    }
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire.mock.calls[0][1]).toBe(60);
  });

  it("rejects the 11th login attempt with 429 and the remaining seconds", async () => {
    const redis = redisWithCounter(10);
    await expect(
      enforceRateLimit(redis as never, LoginRateLimitGuard.rule, request({ email: "a@x.io" })),
    ).rejects.toMatchObject({ status: 429, message: expect.stringContaining("42초") });
  });

  it("keys login attempts by ip and lower-cased login id (nickname first, else email), signup by ip only", () => {
    expect(LoginRateLimitGuard.rule.keyOf(request({ nickname: " Bob " }, "1.2.3.4"))).toBe("1.2.3.4:bob");
    expect(LoginRateLimitGuard.rule.keyOf(request({ email: "Bob@X.io" }, "1.2.3.4"))).toBe("1.2.3.4:bob@x.io");
    expect(LoginRateLimitGuard.rule.keyOf(request({ nickname: "Bob", email: "x@x.io" }, "1.2.3.4"))).toBe("1.2.3.4:bob");
    const forwarded = { body: {}, ip: "127.0.0.1", headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.2" } } as never;
    expect(SignupRateLimitGuard.rule.keyOf(forwarded)).toBe("9.9.9.9");
  });

  it("fails open when redis is unavailable", async () => {
    const redis = { incr: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    await expect(enforceRateLimit(redis as never, LoginRateLimitGuard.rule, request())).resolves.toBeUndefined();
  });

  it("propagates the 429 through the guard", async () => {
    const redis = redisWithCounter(5);
    const guard = new SignupRateLimitGuard(redis as never);
    const context = { switchToHttp: () => ({ getRequest: () => request() }) } as never;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(HttpException);
  });

  it("limits admin login attempts across changing client IPs", async () => {
    const counts = new Map<string, number>();
    const redis = {
      incr: vi.fn(async (key: string) => {
        const value = (counts.get(key) ?? 0) + 1;
        counts.set(key, value);
        return value;
      }),
      expire: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(100),
    };
    const guard = new LoginRateLimitGuard(redis as never);
    for (let i = 0; i < 10; i += 1) {
      const context = { switchToHttp: () => ({ getRequest: () => request({ nickname: "admin" }, `1.2.3.${i}`) }) } as never;
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
    const context = { switchToHttp: () => ({ getRequest: () => request({ nickname: "admin" }, "9.9.9.9") }) } as never;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
  });
});
