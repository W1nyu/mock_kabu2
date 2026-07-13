/** 낙관적 락: 최대 재시도 후에도 version 충돌 */
export class ConflictError extends Error {
  constructor(message = "optimistic lock conflict: max retries exceeded") {
    super(message);
    this.name = "ConflictError";
  }
}

/** 분산 락: 획득 타임아웃 */
export class LockTimeoutError extends Error {
  constructor(message = "failed to acquire lock within timeout") {
    super(message);
    this.name = "LockTimeoutError";
  }
}

/** 분산 락: fencing token이 뒤처짐 (락 유실/TTL 만료 후 좀비 쓰기 시도) */
export class FencingError extends Error {
  constructor(message = "fencing token is stale: lock was lost") {
    super(message);
    this.name = "FencingError";
  }
}
