/** DB 없이 락 전략 오케스트레이션을 검증하기 위한 인메모리 fake들 */

export interface FakeAccountRow {
  id: string;
  balance: bigint;
  hold_amount: bigint;
  version: number;
  fencing_token: bigint;
}

export class FakeStore {
  accounts = new Map<string, FakeAccountRow>();

  addAccount(id: string, balance: bigint) {
    this.accounts.set(id, {
      id,
      balance,
      hold_amount: 0n,
      version: 0,
      fencing_token: 0n,
    });
  }

  snapshot(): Map<string, FakeAccountRow> {
    const copy = new Map<string, FakeAccountRow>();
    for (const [k, v] of this.accounts) copy.set(k, { ...v });
    return copy;
  }

  restore(snap: Map<string, FakeAccountRow>) {
    this.accounts = snap;
  }
}

export interface QueryLogEntry {
  sql: string;
  args: unknown[];
}

/**
 * PrismaLike 를 만족하는 fake.
 * $transaction: 실패 시 스토어 롤백.
 * account.updateMany: where.version / where.fencing_token 가드 시뮬레이션.
 */
export function makeFakePrisma(store: FakeStore) {
  const queryLog: QueryLogEntry[] = [];

  const tx = {
    account: {
      async findUnique({ where }: any) {
        const row = store.accounts.get(where.id);
        if (!row) return null;
        return {
          id: row.id,
          balance: row.balance,
          holdAmount: row.hold_amount,
          version: row.version,
        };
      },
      async updateMany({ where, data }: any) {
        const row = store.accounts.get(where.id);
        if (!row) return { count: 0 };
        if (where.version !== undefined && row.version !== where.version) {
          return { count: 0 };
        }
        if (
          where.fencingToken?.lte !== undefined &&
          !(row.fencing_token <= where.fencingToken.lte)
        ) {
          return { count: 0 };
        }
        if (data.balance !== undefined) row.balance = data.balance;
        if (data.holdAmount !== undefined) row.hold_amount = data.holdAmount;
        if (data.version?.increment) row.version += data.version.increment;
        if (data.fencingToken !== undefined) row.fencing_token = data.fencingToken;
        return { count: 1 };
      },
    },
    async $queryRawUnsafe(sql: string, ...args: unknown[]) {
      queryLog.push({ sql, args });
      if (sql.includes("FOR UPDATE")) {
        const row = store.accounts.get(args[0] as string);
        return row
          ? [{ id: row.id, balance: row.balance, hold_amount: row.hold_amount, version: row.version }]
          : [];
      }
      return [];
    },
    async $executeRawUnsafe(sql: string, ...args: unknown[]) {
      queryLog.push({ sql, args });
      return 0;
    },
  };

  const prisma = {
    async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      const snap = store.snapshot();
      try {
        return await fn(tx);
      } catch (e) {
        store.restore(snap);
        throw e;
      }
    },
  };

  return { prisma, tx, queryLog };
}

/** ioredis 최소 표면 fake (SET NX PX / EVAL 토큰 비교 삭제 / INCR) */
export class FakeRedis {
  data = new Map<string, string>();
  counters = new Map<string, bigint>();

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    const hasNx = args.includes("NX");
    if (hasNx && this.data.has(key)) return null;
    this.data.set(key, value);
    return "OK";
  }

  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    if (this.data.get(key) === token) {
      this.data.delete(key);
      return 1;
    }
    return 0;
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0n) + 1n;
    this.counters.set(key, next);
    return Number(next);
  }
}
