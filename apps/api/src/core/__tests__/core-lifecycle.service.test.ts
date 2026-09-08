import { describe, expect, it, vi } from "vitest";
import { CoreLifecycleService } from "../core-lifecycle.service";

function redisClient(options?: { status?: string; quitError?: boolean }) {
  return {
    status: options?.status ?? "ready",
    quit: options?.quitError ? vi.fn().mockRejectedValue(new Error("connection lost")) : vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
  };
}

describe("CoreLifecycleService", () => {
  it("closes shared Redis clients and disconnects Prisma on shutdown", async () => {
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    const redis = redisClient();
    const redisSub = redisClient();
    const lifecycle = new CoreLifecycleService(prisma as never, redis as never, redisSub as never);

    await lifecycle.onApplicationShutdown();

    expect(redis.quit).toHaveBeenCalledOnce();
    expect(redisSub.quit).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("forces a Redis connection closed when its graceful QUIT fails", async () => {
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    const redis = redisClient({ quitError: true });
    const redisSub = redisClient({ status: "end" });
    const lifecycle = new CoreLifecycleService(prisma as never, redis as never, redisSub as never);

    await lifecycle.onApplicationShutdown();

    expect(redis.disconnect).toHaveBeenCalledOnce();
    expect(redisSub.quit).not.toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });
});
