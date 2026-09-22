/**
 * 내구성 로그(outbox·멱등 claim) 정리 규칙.
 *
 * outbox 행은 Redis에 발행되기 전까지만 필요하고, processed_* claim은 같은 event id가 다시
 * 전달될 수 있는 동안만 필요하다. 스트림은 ACK된 구간을 주기적으로 trim하므로(stream-retention)
 * 며칠 지난 event id는 다시 올 수 없다. 로컬 2주 운영에서 이 테이블들이 4GB를 넘어 실제로
 * 가장 큰 저장소 소비자였다 — 각 프로세스가 자기 테이블을 배치로 조금씩 지운다.
 */
export const LOG_RETENTION = {
  /** 발행(published_at)된 outbox 행을 남겨 두는 시간 */
  PUBLISHED_OUTBOX_MS: 60 * 60 * 1000,
  /**
   * 매칭 쪽 멱등 claim(processed_order_events, closed_order_markers) 보존.
   * `account.processed_events`는 여기서 다루지 않는다 — 체결의 event id가 곧 trade id라서
   * 정합성 검사·복구 플래너가 "그 체결이 정산됐다"는 증거로 쓴다. 체결 행이 남아 있는 동안은
   * claim도 남아야 하며, 봇 체결을 지울 때 함께 지운다(packages/db/scripts/prune-history.ts).
   */
  IDEMPOTENCY_CLAIM_MS: 7 * 24 * 60 * 60 * 1000,
  /** 정리 주기 */
  SWEEP_INTERVAL_MS: 60 * 1000,
  /** 한 번에 지우는 최대 행 수 — 긴 트랜잭션·락을 피한다 */
  BATCH_ROWS: 5_000,
} as const;

export interface RawExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PruneTarget {
  /** 스키마 포함 테이블명, 예: `"order"."outbox"` */
  table: string;
  /** 시각 컬럼명 */
  column: string;
  /** 이 시각 이전 행을 지운다 */
  before: Date;
  /** 추가 WHERE 조건 (선택), 예: `"published_at" IS NOT NULL` */
  extraWhere?: string;
  /** 기본키 컬럼명 (배치 삭제용) */
  key?: string;
}

/**
 * 한 배치만 지우고 지운 행 수를 돌려준다. 호출자가 주기적으로 부르면 밀린 양도 결국 따라잡는다.
 * 테이블·컬럼은 코드 상수라 문자열 결합이 안전하고, 시각만 파라미터로 넘긴다.
 */
export async function pruneBatch(db: RawExecutor, target: PruneTarget): Promise<number> {
  const key = target.key ?? "id";
  const extra = target.extraWhere ? ` AND ${target.extraWhere}` : "";
  return db.$executeRawUnsafe(
    `DELETE FROM ${target.table} WHERE ${key} IN (
       SELECT ${key} FROM ${target.table}
       WHERE "${target.column}" < $1${extra}
       LIMIT ${LOG_RETENTION.BATCH_ROWS}
     )`,
    target.before,
  );
}

/**
 * 밀린 양을 따라잡기 위해 배치가 꽉 찼으면 바로 이어서 지운다(최대 maxLoops번). 정상 운영에서는
 * 한 번에 끝나고, 오래 안 지운 DB에서도 분당 수십만 행씩 줄어든다.
 */
export async function pruneUntilDrained(db: RawExecutor, target: PruneTarget, maxLoops = 20): Promise<number> {
  let total = 0;
  for (let loop = 0; loop < maxLoops; loop += 1) {
    const removed = await pruneBatch(db, target);
    total += removed;
    if (removed < LOG_RETENTION.BATCH_ROWS) break;
  }
  return total;
}
