import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

export const LOCAL_JWT_SECRET = "mock-kabu2-local-dev-secret";
export const LOCAL_LIQUIDITY_BOOTSTRAP_TOKEN = "mock-kabu2-local-liquidity-token";
export const LOCAL_LIQUIDITY_BOT_PASSWORD = "botpassword";

// 모노레포 루트의 .env 를 로드 (src/ 또는 dist/ 어디서 실행돼도 동작)
const projectEnv = resolve(__dirname, "../../../.env");
if (existsSync(projectEnv)) {
  config({ path: projectEnv, override: true });
}

export function jwtSecret(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.JWT_SECRET?.trim() || LOCAL_JWT_SECRET;
}

/** Fail closed when a deploy would otherwise issue forgeable JWTs. */
export function validateRuntimeConfiguration(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;

  const secret = jwtSecret(environment);
  if (secret === LOCAL_JWT_SECRET) {
    throw new Error("JWT_SECRET must be set to a non-default value in production");
  }

  const bootstrapToken = environment.LIQUIDITY_BOOTSTRAP_TOKEN?.trim();
  if (
    !bootstrapToken ||
    bootstrapToken === LOCAL_JWT_SECRET ||
    bootstrapToken === LOCAL_LIQUIDITY_BOOTSTRAP_TOKEN ||
    bootstrapToken === secret
  ) {
    throw new Error(
      "LIQUIDITY_BOOTSTRAP_TOKEN must be a non-default secret distinct from JWT_SECRET in production",
    );
  }

  const botPassword = environment.LIQUIDITY_BOT_PASSWORD?.trim();
  if (!botPassword || botPassword === LOCAL_LIQUIDITY_BOT_PASSWORD) {
    throw new Error("LIQUIDITY_BOT_PASSWORD must be set to a non-default value in production");
  }
}
