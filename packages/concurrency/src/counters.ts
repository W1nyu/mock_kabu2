import type { LockStrategy } from "@mock-kabu/shared";
import type { LockCounters } from "./types";

export function createCounters(strategy: LockStrategy): LockCounters {
  return { strategy, invocations: 0, attempts: 0, conflicts: 0, retries: 0, failures: 0 };
}
