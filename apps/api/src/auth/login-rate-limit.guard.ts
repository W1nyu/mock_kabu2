import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { KEYS } from "@mock-kabu/shared";
import type { Request } from "express";
import type Redis from "ioredis";
import { REDIS } from "../core/tokens";

export interface RateLimitRule {
  /** Redis 키 접두어 구분용 */
  scope: string;
  windowSeconds: number;
  maxAttempts: number;
  /** 요청에서 제한 단위를 뽑는다 (IP, IP+이메일 등). */
  keyOf: (request: Request) => string;
}

export function clientIp(request: Request): string {
  return (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || request.ip || "unknown";
}

/** 60초 창 안에서 같은 출처의 시도 수를 세고, 넘으면 429와 남은 초를 돌려준다. */
export async function enforceRateLimit(redis: Redis, rule: RateLimitRule, request: Request): Promise<void> {
  const key = KEYS.loginAttempts(`${rule.scope}:${rule.keyOf(request)}`);
  try {
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, rule.windowSeconds);
    if (attempts > rule.maxAttempts) {
      const ttl = await redis.ttl(key);
      throw new HttpException(
        `시도가 너무 많습니다. ${Math.max(1, ttl)}초 뒤 다시 시도하세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    // Redis가 잠시 죽어 있으면 막지 않는다(가용성 우선).
    console.error(`[auth] rate limit (${rule.scope}) unavailable, allowing request`, error);
  }
}

/**
 * 로그인 무차별 대입 완화. IP+로그인 ID(닉네임, 시스템 계정은 이메일)당 60초 10회. Redis 카운터(INCR + EXPIRE)라 API 복제본이
 * 여러 개여도 같은 한도를 공유하며, 성공/실패를 가리지 않고 시도 자체를 센다.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  static readonly rule: RateLimitRule = {
    scope: "login",
    windowSeconds: 60,
    maxAttempts: 10,
    keyOf: (request) =>
      `${clientIp(request)}:${loginIdentifierOf(request.body).toLowerCase().slice(0, 200)}`,
  };
  static readonly accountRule: RateLimitRule = {
    scope: "login-account",
    windowSeconds: 900,
    maxAttempts: 30,
    keyOf: (request) => loginIdentifierOf(request.body).toLowerCase().slice(0, 200),
  };
  static readonly adminRule: RateLimitRule = {
    scope: "login-admin",
    windowSeconds: 900,
    maxAttempts: 10,
    keyOf: () => "admin",
  };

  constructor(@Inject(REDIS) private redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await enforceRateLimit(this.redis, LoginRateLimitGuard.rule, request);
    await enforceRateLimit(this.redis, LoginRateLimitGuard.accountRule, request);
    const identifier = loginIdentifierOf(request.body).toLowerCase();
    if (identifier === "admin" || identifier.startsWith("admin@")) {
      await enforceRateLimit(this.redis, LoginRateLimitGuard.adminRule, request);
    }
    return true;
  }
}

/** 비밀번호 재확인(비밀번호 변경) 시도를 로그인한 사용자 기준으로 1분 10회로 제한한다. IP와 무관. */
@Injectable()
export class PasswordRecheckRateLimitGuard implements CanActivate {
  static readonly rule: RateLimitRule = {
    scope: "password",
    windowSeconds: 60,
    maxAttempts: 10,
    keyOf: (request) => (request as Request & { user?: { userId?: string } }).user?.userId ?? "anonymous",
  };

  constructor(@Inject(REDIS) private redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await enforceRateLimit(this.redis, PasswordRecheckRateLimitGuard.rule, context.switchToHttp().getRequest<Request>());
    return true;
  }
}

/** 가입 스팸 완화. 닉네임은 마음대로 바꿀 수 있으니 IP당 10분 5회로 센다. */
@Injectable()
export class SignupRateLimitGuard implements CanActivate {
  static readonly rule: RateLimitRule = {
    scope: "signup",
    windowSeconds: 600,
    maxAttempts: 5,
    keyOf: (request) => clientIp(request),
  };

  constructor(@Inject(REDIS) private redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await enforceRateLimit(this.redis, SignupRateLimitGuard.rule, context.switchToHttp().getRequest<Request>());
    return true;
  }
}

function loginIdentifierOf(body: unknown): string {
  const { nickname, email } = (body ?? {}) as { nickname?: unknown; email?: unknown };
  if (typeof nickname === "string" && nickname.trim()) return nickname.trim();
  return typeof email === "string" ? email : "";
}
