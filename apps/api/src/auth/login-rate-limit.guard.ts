import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { KEYS } from "@mock-kabu/shared";
import type { Request } from "express";
import type Redis from "ioredis";
import { REDIS } from "../core/tokens";

/** 같은 출처(IP+이메일)에서 이 창 안에 허용하는 로그인 시도 수. */
const WINDOW_SECONDS = 60;
const MAX_ATTEMPTS = 10;

/**
 * 로그인 무차별 대입 완화. Redis 카운터(INCR + EXPIRE)라 API 복제본이 여러 개여도 같은
 * 한도를 공유한다. 성공/실패를 가리지 않고 시도 자체를 세며, 창이 지나면 자연히 풀린다.
 * Redis가 잠시 죽어 있으면 로그인을 막지 않는다(가용성 우선).
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS) private redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || request.ip || "unknown";
    const email = String((request.body as { email?: unknown })?.email ?? "").toLowerCase().slice(0, 200);
    const key = KEYS.loginAttempts(`${ip}:${email}`);
    try {
      const attempts = await this.redis.incr(key);
      if (attempts === 1) await this.redis.expire(key, WINDOW_SECONDS);
      if (attempts > MAX_ATTEMPTS) {
        const ttl = await this.redis.ttl(key);
        throw new HttpException(
          `로그인 시도가 너무 많습니다. ${Math.max(1, ttl)}초 뒤 다시 시도하세요`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error("[auth] login rate limit unavailable, allowing request", error);
      return true;
    }
  }
}
