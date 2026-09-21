import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 순수 로직(lib/*)만 node 환경에서 검사한다. 컴포넌트는 브라우저·소켓에 묶여 있어 여기서 다루지 않는다.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
