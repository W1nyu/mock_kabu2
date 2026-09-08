import { Global, Module } from "@nestjs/common";
import { getPrisma } from "@mock-kabu/db";
import { createBalanceMutator } from "@mock-kabu/concurrency";
import Redis from "ioredis";
import { CoreLifecycleService } from "./core-lifecycle.service";
import { readApiRuntimeConfig, type ApiRuntimeConfig } from "./runtime-config";
import { API_RUNTIME_CONFIG, BALANCE_MUTATOR, PRISMA, REDIS, REDIS_SUB } from "./tokens";

const runtimeConfig = readApiRuntimeConfig();

@Global()
@Module({
  providers: [
    { provide: API_RUNTIME_CONFIG, useValue: runtimeConfig },
    { provide: PRISMA, useFactory: () => getPrisma() },
    {
      provide: REDIS,
      inject: [API_RUNTIME_CONFIG],
      useFactory: (config: ApiRuntimeConfig) => new Redis(config.redisUrl),
    },
    // Pub/Sub 구독 전용 커넥션 (구독 모드에선 일반 명령 불가)
    {
      provide: REDIS_SUB,
      inject: [API_RUNTIME_CONFIG],
      useFactory: (config: ApiRuntimeConfig) => new Redis(config.redisUrl),
    },
    {
      provide: BALANCE_MUTATOR,
      inject: [PRISMA, REDIS, API_RUNTIME_CONFIG],
      useFactory: (prisma: ReturnType<typeof getPrisma>, redis: Redis, config: ApiRuntimeConfig) => {
        return createBalanceMutator(config.lockStrategy, prisma, redis);
      },
    },
    CoreLifecycleService,
  ],
  exports: [API_RUNTIME_CONFIG, PRISMA, REDIS, REDIS_SUB, BALANCE_MUTATOR],
})
export class CoreModule {}
