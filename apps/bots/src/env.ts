import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// 모노레포 루트의 .env 를 로드
const projectEnv = resolve(__dirname, "../../../.env");
if (existsSync(projectEnv)) {
  config({ path: projectEnv, override: true });
}

/**
 * 양의 숫자 환경변수. 없거나 잘못됐으면 기본값. 봇 부하 조절(폴링 주기·흐름 속도)에 쓴다.
 */
export function numericRuntimeEnv(name: string, fallback: number, { min = 0 }: { min?: number } = {}): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Local development remains zero-config, but a public deployment must never
 * silently fall back to credentials committed to the repository.
 */
export function requiredRuntimeEnv(name: string, developmentDefault: string): string {
  const value = process.env[name]?.trim();
  if (value && (process.env.NODE_ENV !== "production" || value !== developmentDefault)) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set to a non-default value when NODE_ENV=production`);
  }
  return developmentDefault;
}
