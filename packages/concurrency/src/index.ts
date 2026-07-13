import type { LockStrategy } from "@mock-kabu/shared";
import { DistributedMutator } from "./distributed";
import { OptimisticMutator } from "./optimistic";
import { PessimisticMutator } from "./pessimistic";
import type { BalanceMutator, PrismaLike, RedisLike } from "./types";

export * from "./errors";
export * from "./types";
export { OptimisticMutator } from "./optimistic";
export { PessimisticMutator } from "./pessimistic";
export { DistributedMutator } from "./distributed";

/** LOCK_STRATEGY 환경 변수 값으로 구현체를 선택한다 (스펙 4.2) */
export function createBalanceMutator(
  strategy: LockStrategy,
  prisma: PrismaLike,
  redis?: RedisLike,
): BalanceMutator {
  switch (strategy) {
    case "optimistic":
      return new OptimisticMutator(prisma);
    case "pessimistic":
      return new PessimisticMutator(prisma);
    case "distributed":
      if (!redis) throw new Error("distributed lock strategy requires a redis client");
      return new DistributedMutator(prisma, redis);
    default:
      throw new Error(`unknown lock strategy: ${strategy satisfies never}`);
  }
}
