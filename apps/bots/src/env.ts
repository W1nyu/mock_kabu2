import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// 모노레포 루트의 .env 를 로드
const projectEnv = resolve(__dirname, "../../../.env");
if (existsSync(projectEnv)) {
  config({ path: projectEnv, override: true });
}
