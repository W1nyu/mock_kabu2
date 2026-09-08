import "reflect-metadata";
import type { NextFunction, Request, Response } from "express";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { validateRuntimeConfiguration } from "./env";
import { readApiRuntimeConfig } from "./core/runtime-config";

// BigInt(잔액 등)를 JSON 응답에 안전하게 직렬화
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  validateRuntimeConfiguration();
  const runtimeConfig = readApiRuntimeConfig();
  // Feature modules create their Redis clients from this validated config at
  // import time. Loading them only after validation keeps every startup error
  // on the bootstrap failure path below.
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: runtimeConfig.webOrigins, credentials: true });
  app.disable("x-powered-by");
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
  await app.listen(runtimeConfig.apiPort);
  console.log(`[api] listening on :${runtimeConfig.apiPort} (lock strategy: ${runtimeConfig.lockStrategy})`);
}

bootstrap().catch((error) => {
  console.error("[api] bootstrap failed", error);
  process.exitCode = 1;
});
