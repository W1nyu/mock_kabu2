import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import type { LockStrategy } from "@mock-kabu/shared";

const projectEnv = resolve(__dirname, "../../../.env");
if (existsSync(projectEnv)) {
  config({ path: projectEnv, override: true });
}

const LOCK_STRATEGIES: readonly LockStrategy[] = ["optimistic", "pessimistic", "distributed"];

export interface SettlementRuntimeConfig {
  redisUrl: string;
  lockStrategy: LockStrategy;
}

/** Fail at worker startup instead of reconnecting against an unintended endpoint. */
export function readSettlementRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): SettlementRuntimeConfig {
  const redisUrl = environment.REDIS_URL?.trim() || "redis://localhost:56379";
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if ((parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") || !parsed.hostname) {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }

  const lockStrategy = environment.LOCK_STRATEGY?.trim() || "pessimistic";
  if (!LOCK_STRATEGIES.includes(lockStrategy as LockStrategy)) {
    throw new Error(`LOCK_STRATEGY must be one of: ${LOCK_STRATEGIES.join(", ")}`);
  }
  return { redisUrl, lockStrategy: lockStrategy as LockStrategy };
}
