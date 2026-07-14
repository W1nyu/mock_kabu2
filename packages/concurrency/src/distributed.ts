import { randomUUID } from "node:crypto";
import { REDIS_NAMESPACE } from "@mock-kabu/shared";
import { createCounters } from "./counters";
import { FencingError, LockTimeoutError } from "./errors";
import type {
  AccountState,
  BalanceMutator,
  LockCounters,
  LockCtx,
  PrismaLike,
  RedisLike,
} from "./types";

export interface DistributedOptions {
  /** 락 TTL (기본 5000ms) */
  ttlMs?: number;
  /** 획득 대기 상한 (기본 3000ms) */
  acquireTimeoutMs?: number;
  /** 획득 재시도 간격 (기본 30ms) */
  retryDelayMs?: number;
}

/** 토큰이 일치할 때만 삭제 — 자기 락만 해제 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lockKey = (accountId: string) => `${REDIS_NAMESPACE}:lock:account:${accountId}`;
const fenceKey = (accountId: string) => `${REDIS_NAMESPACE}:fence:account:${accountId}`;

/**
 * ③ Redis 분산 락 (스펙 4.2):
 * SET lock:account:{id} {token} NX PX {ttl} + 토큰 비교 Lua 해제.
 * TTL 만료 후 좀비 쓰기는 fencing token(락 획득 시 INCR로 받은 단조 증가 값을
 * DB 갱신 조건에 포함)으로 방어한다.
 * 여러 계좌는 ID 오름차순으로 순차 획득해 데드락을 방지한다.
 */
export class DistributedMutator implements BalanceMutator {
  readonly strategy = "distributed" as const;
  private counters = createCounters("distributed");

  constructor(
    private prisma: PrismaLike,
    private redis: RedisLike,
    private options: DistributedOptions = {},
  ) {}

  async withAccountLock<T>(accountIds: string[], fn: (ctx: LockCtx) => Promise<T>): Promise<T> {
    this.counters.invocations++;
    const ids = [...new Set(accountIds)].sort();
    const token = randomUUID();
    const ttl = this.options.ttlMs ?? 5000;
    const acquired: string[] = [];
    const fences = new Map<string, bigint>();

    try {
      for (const id of ids) {
        await this.acquire(lockKey(id), token, ttl);
        acquired.push(id);
        fences.set(id, BigInt(await this.redis.incr(fenceKey(id))));
      }

      this.counters.attempts++;
      return await this.prisma.$transaction(async (tx) => {
        const accounts: Record<string, AccountState> = {};
        for (const id of ids) {
          const row = await tx.account.findUnique({ where: { id } });
          if (!row) throw new Error(`account not found: ${id}`);
          accounts[id] = {
            id,
            balance: row.balance,
            holdAmount: row.holdAmount,
            version: row.version,
          };
        }

        const ctx: LockCtx = {
          tx,
          accounts,
          updateAccount: async (id, patch) => {
            if (!accounts[id]) throw new Error(`account not locked: ${id}`);
            const fence = fences.get(id)!;
            const res = await tx.account.updateMany({
              // fencing_token이 내 토큰보다 크면 이미 다른(더 새로운) 보유자가 썼다 → 거부
              where: { id, fencingToken: { lte: fence } },
              data: {
                balance: patch.balance,
                holdAmount: patch.holdAmount,
                version: { increment: 1 },
                fencingToken: fence,
              },
            });
            if (res.count === 0) {
              this.counters.conflicts++;
              throw new FencingError();
            }
          },
        };

        return await fn(ctx);
      });
    } catch (e) {
      if (e instanceof FencingError || e instanceof LockTimeoutError) {
        this.counters.failures++;
      }
      throw e;
    } finally {
      for (const id of acquired) {
        await this.redis.eval(RELEASE_SCRIPT, 1, lockKey(id), token);
      }
    }
  }

  private async acquire(key: string, token: string, ttl: number): Promise<void> {
    const timeout = this.options.acquireTimeoutMs ?? 3000;
    const retryDelay = this.options.retryDelayMs ?? 30;
    const deadline = Date.now() + timeout;
    let contended = false;

    while (true) {
      const ok = await this.redis.set(key, token, "PX", ttl, "NX");
      if (ok === "OK") return;
      if (!contended) {
        contended = true;
        this.counters.conflicts++;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError();
      this.counters.retries++;
      await sleep(retryDelay + Math.random() * retryDelay * 0.5);
    }
  }

  getCounters(): LockCounters {
    return { ...this.counters };
  }
}
