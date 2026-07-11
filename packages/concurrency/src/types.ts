import type { LockStrategy } from "@mock-kabu/shared";

/**
 * PrismaClient / TransactionClient의 구조적 최소 표면.
 * 실제 클라이언트와 테스트 fake가 모두 만족한다.
 */
export interface TxLike {
  account: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; balance: bigint; holdAmount: bigint; version: number } | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  $queryRawUnsafe(sql: string, ...args: unknown[]): Promise<unknown>;
  $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<unknown>;
  // 실제 Prisma TransactionClient의 나머지 모델 델리게이트 (ledgerEntry, holding, order, outbox 등)
  [key: string]: any;
}

export interface PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, opts?: { timeout?: number }): Promise<T>;
}

export interface RedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export interface AccountState {
  id: string;
  balance: bigint;
  holdAmount: bigint;
  version: number;
}

export interface LockCtx {
  /** 같은 DB 트랜잭션으로 다른 테이블(원장, 보유, 주문)도 함께 쓸 수 있다 */
  tx: TxLike;
  /** 잠긴(또는 읽힌) 계좌 스냅샷 */
  accounts: Record<string, AccountState>;
  /**
   * 잔액/홀드 갱신. 전략별 가드(version / fencing token)가 적용된다.
   * 낙관적 전략에서는 호출하지 않은 계좌도 커밋 시점에 version이 올라간다.
   */
  updateAccount(id: string, patch: { balance: bigint; holdAmount: bigint }): Promise<void>;
}

export interface LockCounters {
  strategy: LockStrategy;
  /** withAccountLock 호출 수 */
  invocations: number;
  /** 트랜잭션 시도 수 (재시도 포함) */
  attempts: number;
  /** 충돌 감지 수 */
  conflicts: number;
  /** 재시도 수 */
  retries: number;
  /** 최종 실패 수 */
  failures: number;
}

export interface BalanceMutator {
  readonly strategy: LockStrategy;
  /**
   * fn 안에서 잔액 읽기→검증→쓰기가 원자적으로 보장된다.
   * 여러 계좌를 잠글 때는 항상 ID 오름차순으로 잠근다.
   */
  withAccountLock<T>(accountIds: string[], fn: (ctx: LockCtx) => Promise<T>): Promise<T>;
  getCounters(): LockCounters;
}
