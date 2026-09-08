import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// 모노레포 루트의 .env 를 로드
const projectEnv = resolve(__dirname, "../../../.env");
if (existsSync(projectEnv)) {
  config({ path: projectEnv, override: true });
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
