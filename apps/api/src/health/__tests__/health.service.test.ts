import { describe, expect, it, vi } from "vitest";
import { HealthService } from "../health.service";

function makeService(options?: {
  databaseError?: boolean;
  redisError?: boolean;
  heartbeat?: string | null;
  heartbeatTtlMs?: number;
  workerStatus?: string | null;
}) {
  const prisma = {
    $queryRawUnsafe: options?.databaseError
      ? vi.fn().mockRejectedValue(new Error("database unavailable"))
      : vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  };
  const redis = {
    ping: options?.redisError ? vi.fn().mockRejectedValue(new Error("redis unavailable")) : vi.fn().mockResolvedValue("PONG"),
    get: vi.fn((key: string) =>
      Promise.resolve(
        key.includes("heartbeat-status")
          ? (options?.workerStatus ?? null)
          : (options?.heartbeat ?? '{"updatedAt":"2026-08-08T00:00:00.000Z"}'),
      ),
    ),
    pttl: vi.fn().mockResolvedValue(options?.heartbeatTtlMs ?? 15_000),
  };
  return { service: new HealthService(prisma as never, redis as never), prisma, redis };
}

describe("HealthService", () => {
  it("reports database, Redis, and a fresh matching heartbeat as ready", async () => {
    const { service, prisma, redis } = makeService();

    const report = await service.readiness();

    expect(report).toMatchObject({
      status: "ok",
      service: "api",
      dependencies: {
        database: { status: "up" },
        redis: { status: "up" },
      },
      workers: { matchingEngine: { status: "up", ttlMs: 15_000 } },
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith("SELECT 1");
    expect(redis.ping).toHaveBeenCalledOnce();
  });

  it("keeps API readiness up while a matching-engine heartbeat is absent", async () => {
    const { service } = makeService({ heartbeat: null, heartbeatTtlMs: -2 });

    const report = await service.readiness();

    expect(report.status).toBe("ok");
    expect(report.workers.matchingEngine).toEqual({ status: "down", error: "heartbeat missing" });
  });

  it("reports retained financial events as degraded and blocks trading readiness", async () => {
    const { service } = makeService({
      workerStatus: JSON.stringify({
        state: "degraded",
        retainedEventCount: 2,
        lastFailureAt: "2026-08-08T00:00:00.000Z",
      }),
    });

    const report = await service.tradingReadiness();

    expect(report.status).toBe("error");
    expect(report.workers.matchingEngine).toMatchObject({
      status: "degraded",
      retainedEventCount: 2,
    });
  });

  it("returns an error readiness report when a primary dependency fails", async () => {
    const { service } = makeService({ databaseError: true, redisError: true });

    const report = await service.readiness();

    expect(report).toMatchObject({
      status: "error",
      dependencies: {
        database: { status: "down", error: "database query failed" },
        redis: { status: "down", error: "redis ping failed" },
      },
      workers: { matchingEngine: { status: "unknown", error: "redis unavailable" } },
    });
  });

  it("does not probe dependencies for liveness", () => {
    const { service, prisma, redis } = makeService();

    expect(service.liveness()).toMatchObject({ status: "ok", service: "api" });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});
