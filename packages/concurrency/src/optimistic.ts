import { createCounters } from "./counters";
import { ConflictError } from "./errors";
import type { AccountState, BalanceMutator, LockCounters, LockCtx, PrismaLike } from "./types";

export interface OptimisticOptions {
  /** 총 시도 횟수 (기본 5) */
  maxRetries?: number;
  /** 백오프 기본 지연 (기본 10ms) */
  baseDelayMs?: number;
}

/** 트랜잭션 내부에서 version 충돌을 상위 재시도 루프로 전달하는 내부 마커 */
class VersionConflict extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ① 낙관적 락 (스펙 4.2):
 * UPDATE ... WHERE version = 읽은값 → 영향 행 0이면 충돌로 판단,
 * 지수 백오프 + 지터로 재시도. 초과 시 ConflictError(→ HTTP 409).
 *
 * fn이 갱신하지 않은 계좌도 커밋 시 version을 올려(touch)
 * 보유자산 등 부속 행 변경까지 계좌 단위로 직렬화한다.
 */
export class OptimisticMutator implements BalanceMutator {
  readonly strategy = "optimistic" as const;
  private counters = createCounters("optimistic");

  constructor(
    private prisma: PrismaLike,
    private options: OptimisticOptions = {},
  ) {}

  async withAccountLock<T>(accountIds: string[], fn: (ctx: LockCtx) => Promise<T>): Promise<T> {
    this.counters.invocations++;
    const maxRetries = this.options.maxRetries ?? 5;
    const baseDelay = this.options.baseDelayMs ?? 10;
    const ids = [...new Set(accountIds)].sort();

    for (let attempt = 1; ; attempt++) {
      this.counters.attempts++;
      try {
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

          const updated = new Set<string>();
          const ctx: LockCtx = {
            tx,
            accounts,
            updateAccount: async (id, patch) => {
              const acc = accounts[id];
              if (!acc) throw new Error(`account not locked: ${id}`);
              const res = await tx.account.updateMany({
                where: { id, version: acc.version },
                data: {
                  balance: patch.balance,
                  holdAmount: patch.holdAmount,
                  version: { increment: 1 },
                },
              });
              if (res.count === 0) throw new VersionConflict();
              updated.add(id);
            },
          };

          const result = await fn(ctx);

          // 갱신되지 않은 계좌도 version touch — 충돌 감지 겸 직렬화 지점
          for (const id of ids) {
            if (updated.has(id)) continue;
            const res = await tx.account.updateMany({
              where: { id, version: accounts[id].version },
              data: { version: { increment: 1 } },
            });
            if (res.count === 0) throw new VersionConflict();
          }

          return result;
        });
      } catch (e) {
        if (!(e instanceof VersionConflict)) throw e;
        this.counters.conflicts++;
        if (attempt >= maxRetries) {
          this.counters.failures++;
          throw new ConflictError();
        }
        this.counters.retries++;
        const backoff = baseDelay * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * baseDelay);
      }
    }
  }

  getCounters(): LockCounters {
    return { ...this.counters };
  }
}
