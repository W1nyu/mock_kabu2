import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// 모노레포 루트의 .env 를 로드
for (const rel of ["../../../.env", "../../../../.env"]) {
  const p = resolve(__dirname, rel);
  if (existsSync(p)) {
    config({ path: p });
    break;
  }
}
