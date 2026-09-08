import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import type Redis from "ioredis";
import { PRISMA, REDIS, REDIS_SUB } from "./tokens";

/**
 * Releases shared infrastructure only after Nest has stopped accepting work.
 * Dedicated stream consumers release their own connections in onModuleDestroy.
 */
@Injectable()
export class CoreLifecycleService implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUB) private readonly redisSub: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    const results = await Promise.allSettled([
      this.closeRedis(this.redis),
      this.closeRedis(this.redisSub),
      this.prisma.$disconnect(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        // Shutdown should continue even if a dependency is already unavailable.
        console.error("[core] infrastructure shutdown failed", result.reason);
      }
    }
  }

  private async closeRedis(redis: Redis): Promise<void> {
    if (redis.status === "end") return;

    try {
      await redis.quit();
    } catch {
      // A failed QUIT normally means the connection is already unusable.  Force
      // it closed so a shutdown signal cannot be held by Redis retry timers.
      redis.disconnect();
    }
  }
}
