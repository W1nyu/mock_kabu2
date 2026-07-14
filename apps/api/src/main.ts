import "./env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

// BigInt(잔액 등)를 JSON 응답에 안전하게 직렬화
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const webOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:3100,http://127.0.0.1:3100")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: webOrigins, credentials: true });
  const port = Number(process.env.API_PORT ?? 4100);
  await app.listen(port);
  console.log(`[api] listening on :${port} (lock strategy: ${process.env.LOCK_STRATEGY ?? "pessimistic"})`);
}

bootstrap();
