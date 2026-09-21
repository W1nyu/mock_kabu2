import { Inject, Injectable, Optional } from "@nestjs/common";
import { KEYS, WORKERS } from "@mock-kabu/shared";
import type { PrismaClient } from "@mock-kabu/db";
import type Redis from "ioredis";
import { BackgroundStatusRegistry } from "../core/background-status";
import { HEALTH_WORKER_PROBE, PRISMA, REDIS } from "../core/tokens";
import type {
  DependencyHealth,
  HealthWorkerProbe,
  LivenessReport,
  ReadinessReport,
  WorkerHealth,
} from "./health.types";

@Injectable()
export class HealthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(HEALTH_WORKER_PROBE) private readonly workerProbe?: HealthWorkerProbe,
    @Optional() private readonly background?: BackgroundStatusRegistry,
  ) {}

  liveness(): LivenessReport {
    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([this.probeDatabase(), this.probeRedis()]);
    const workers = await this.probeWorkers(redis.status === "up");

    return {
      status: database.status === "up" && redis.status === "up" ? "ok" : "error",
      service: "api",
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
      workers,
      ...(this.background ? { background: this.background.snapshot() } : {}),
    };
  }

  /**
   * Full exchange readiness, for operators and traffic that requires an
   * end-to-end order path. The ordinary API readiness intentionally remains
   * independent so Compose can start the API before its workers.
   */
  async tradingReadiness(): Promise<ReadinessReport> {
    const report = await this.readiness();
    const workersReady =
      report.workers.matchingEngine?.status === "up" && report.workers.settlement?.status === "up";
    return { ...report, status: report.status === "ok" && workersReady ? "ok" : "error" };
  }

  private async probeDatabase(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch {
      return {
        status: "down",
        latencyMs: Date.now() - startedAt,
        error: "database query failed",
      };
    }
  }

  private async probeRedis(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      const response = await this.redis.ping();
      if (response !== "PONG") {
        return {
          status: "down",
          latencyMs: Date.now() - startedAt,
          error: "unexpected ping response",
        };
      }
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch {
      return {
        status: "down",
        latencyMs: Date.now() - startedAt,
        error: "redis ping failed",
      };
    }
  }

  private async probeWorkers(redisReady: boolean): Promise<Record<string, WorkerHealth>> {
    const [matchingEngine, settlement] = redisReady
      ? await Promise.all([this.probeWorker(WORKERS.MATCHING_ENGINE), this.probeWorker(WORKERS.SETTLEMENT)])
      : [
          { status: "unknown" as const, error: "redis unavailable" },
          { status: "unknown" as const, error: "redis unavailable" },
        ];

    if (!this.workerProbe) return { matchingEngine, settlement };

    try {
      const extendedWorkers = await this.workerProbe.check();
      // Keep built-in critical worker signals authoritative even if an
      // extension accidentally reuses their display names.
      return { ...extendedWorkers, matchingEngine, settlement };
    } catch {
      return {
        matchingEngine,
        settlement,
        workerProbe: { status: "unknown", error: "worker status probe failed" },
      };
    }
  }

  private async probeWorker(worker: string): Promise<WorkerHealth> {
    try {
      const key = KEYS.heartbeat(worker);
      const [value, ttlMs, statusValue] = await Promise.all([
        this.redis.get(key),
        this.redis.pttl(key),
        this.redis.get(KEYS.workerHealth(worker)),
      ]);

      if (value === null || ttlMs === -2) {
        return { status: "down", error: "heartbeat missing" };
      }
      if (ttlMs <= 0) {
        return { status: "down", error: "heartbeat has no expiry" };
      }

      // Older workers expose only a heartbeat, so lack of the optional
      // metadata remains healthy. New workers can surface durable stream
      // failures without making an otherwise responsive API look down.
      if (statusValue !== null) {
        try {
          const metadata = JSON.parse(statusValue) as {
            state?: unknown;
            retainedEventCount?: unknown;
            lastFailureAt?: unknown;
          };
          if (metadata.state === "degraded") {
            return {
              status: "degraded",
              ttlMs,
              retainedEventCount:
                typeof metadata.retainedEventCount === "number" ? metadata.retainedEventCount : undefined,
              lastFailureAt: typeof metadata.lastFailureAt === "string" ? metadata.lastFailureAt : undefined,
              error: "worker has retained stream events",
            };
          }
        } catch {
          return { status: "unknown", ttlMs, error: "worker heartbeat metadata is invalid" };
        }
      }
      return { status: "up", ttlMs };
    } catch {
      return { status: "unknown", error: "heartbeat probe failed" };
    }
  }
}
