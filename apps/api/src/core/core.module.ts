import { Global, Module } from "@nestjs/common";
import { getPrisma } from "@mock-kabu/db";
import { createBalanceMutator } from "@mock-kabu/concurrency";
import type { LockStrategy } from "@mock-kabu/shared";
import Redis from "ioredis";
import { BALANCE_MUTATOR, PRISMA, REDIS, REDIS_SUB } from "./tokens";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

@Global()
@Module({
  providers: [
    { provide: PRISMA, useFactory: () => getPrisma() },
    { provide: REDIS, useFactory: () => new Redis(REDIS_URL) },
    // Pub/Sub 구독 전용 커넥션 (구독 모드에선 일반 명령 불가)
    { provide: REDIS_SUB, useFactory: () => new Redis(REDIS_URL) },
    {
      provide: BALANCE_MUTATOR,
      inject: [PRISMA, REDIS],
      useFactory: (prisma: ReturnType<typeof getPrisma>, redis: Redis) => {
        const strategy = (process.env.LOCK_STRATEGY ?? "pessimistic") as LockStrategy;
        return createBalanceMutator(strategy, prisma, redis);
      },
    },
  ],
  exports: [PRISMA, REDIS, REDIS_SUB, BALANCE_MUTATOR],
})
export class CoreModule {}
