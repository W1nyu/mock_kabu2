import "../env";
import type { LockStrategy } from "@mock-kabu/shared";

const DEFAULT_REDIS_URL = "redis://localhost:56379";
const DEFAULT_WEB_ORIGINS = ["http://localhost:3100", "http://127.0.0.1:3100"];
const DEFAULT_API_PORT = 4100;
const LOCK_STRATEGIES: readonly LockStrategy[] = ["optimistic", "pessimistic", "distributed"];

/**
 * Immutable, validated process configuration used by the API composition root.
 *
 * Keeping this separate from feature services makes environment parsing a
 * startup concern and prevents individual modules from silently choosing
 * different defaults for the same infrastructure connection.
 */
export interface ApiRuntimeConfig {
  apiPort: number;
  redisUrl: string;
  webOrigins: string[];
  lockStrategy: LockStrategy;
}

export function readApiRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  return {
    apiPort: readPort(environment.API_PORT),
    redisUrl: readRedisUrl(environment.REDIS_URL),
    webOrigins: readWebOrigins(environment.WEB_ORIGIN),
    lockStrategy: readLockStrategy(environment.LOCK_STRATEGY),
  };
}

function readPort(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_API_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readRedisUrl(value: string | undefined): string {
  const redisUrl = value?.trim() || DEFAULT_REDIS_URL;
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if ((parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") || !parsed.hostname) {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  return redisUrl;
}

function readWebOrigins(value: string | undefined): string[] {
  const rawOrigins = value?.trim() ? value.split(",") : DEFAULT_WEB_ORIGINS;
  const origins = rawOrigins.map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("WEB_ORIGIN must include at least one HTTP(S) origin");

  return origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`WEB_ORIGIN contains an invalid origin: ${origin}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`WEB_ORIGIN must contain plain HTTP(S) origins: ${origin}`);
    }
    return parsed.origin;
  });
}

function readLockStrategy(value: string | undefined): LockStrategy {
  const strategy = value?.trim() || "pessimistic";
  if (!LOCK_STRATEGIES.includes(strategy as LockStrategy)) {
    throw new Error(`LOCK_STRATEGY must be one of: ${LOCK_STRATEGIES.join(", ")}`);
  }
  return strategy as LockStrategy;
}
