import { createCounters } from "./counters";
import type { AccountState, BalanceMutator, LockCounters, LockCtx, PrismaLike } from "./types";

export interface PessimisticOptions {
  /** SELECT ... FOR UPDATE 대기 상한 (기본 3000ms) */
  lockTimeoutMs?: number;
}

interface RawAccountRow {
  id: string;
  balance: bigint | number | string;
  hold_amount: bigint | number | string;
  version: number;
}

/**
 * ② 비관적 락 (스펙 4.2):
 * 트랜잭션 내 SELECT ... FOR UPDATE(원시 SQL) 후 검증·갱신.
 * 데드락 방지: 여러 계좌는 항상 ID 오름차순으로 잠근다.
 * lock_timeout으로 무한 대기를 차단한다.
 */
export class PessimisticMutator implements BalanceMutator {
  readonly strategy = "pessimistic" as const;
  private counters = createCounters("pessimistic");

  constructor(
    private prisma: PrismaLike,
    private options: PessimisticOptions = {},
  ) {}

  async withAccountLock<T>(accountIds: string[], fn: (ctx: LockCtx) => Promise<T>): Promise<T> {
    this.counters.invocations++;
    this.counters.attempts++;
    const ids = [...new Set(accountIds)].sort();
    const lockTimeout = this.options.lockTimeoutMs ?? 3000;

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);

        const accounts: Record<string, AccountState> = {};
        for (const id of ids) {
          const rows = (await tx.$queryRawUnsafe(
            `SELECT id, balance, hold_amount, version FROM "account"."accounts" WHERE id = $1 FOR UPDATE`,
            id,
          )) as RawAccountRow[];
          const row = rows[0];
          if (!row) throw new Error(`account not found: ${id}`);
          accounts[id] = {
            id,
            balance: BigInt(row.balance),
            holdAmount: BigInt(row.hold_amount),
            version: row.version,
          };
        }

        const ctx: LockCtx = {
          tx,
          accounts,
          updateAccount: async (id, patch) => {
            if (!accounts[id]) throw new Error(`account not locked: ${id}`);
            await tx.account.updateMany({
              where: { id },
              data: {
                balance: patch.balance,
                holdAmount: patch.holdAmount,
                version: { increment: 1 },
              },
            });
          },
        };

        return await fn(ctx);
      });
    } catch (e) {
      this.counters.failures++;
      throw e;
    }
  }

  getCounters(): LockCounters {
    return { ...this.counters };
  }
}
