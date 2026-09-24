import { timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { SYMBOLS } from "@mock-kabu/shared";
import { PRISMA } from "../core/tokens";
import { liquidityBootstrapToken } from "../liquidity/liquidity-reserve";

const ACTIVE_SYMBOLS = new Set(SYMBOLS.map((symbol) => symbol.symbol));

export type ScenarioDirection = "UP" | "DOWN";

/** 한 번에 하루를 넘기면 운영자가 잊고 둔 시나리오가 시장을 계속 끌고 간다. */
export const MAX_SCENARIO_DURATION_MS = 24 * 60 * 60_000;
export const MIN_SCENARIO_DURATION_MS = 5 * 60_000;
/** 먼 미래 예약은 잊히기 쉬워 일주일로 제한한다. */
export const MAX_SCENARIO_LEAD_MS = 7 * 24 * 60 * 60_000;
/** 폼을 채우는 사이 시작 시각이 막 지나간 경우는 받아 준다. */
const START_GRACE_MS = 5 * 60_000;
/** 봇은 곧 시작할 것까지 미리 받아 둔다(폴링 간격보다 넉넉히). */
const INTERNAL_LOOKAHEAD_MS = 60 * 60_000;

export interface CreateScenarioDto {
  symbols?: unknown;
  direction?: unknown;
  intensity?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

export interface ScenarioDto {
  id: string;
  symbols: string[];
  direction: ScenarioDirection;
  intensity: number;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  canceledAt: string | null;
  createdAt: string;
}

/** 봇이 받는 최소 형태. 누가 만들었는지는 봇에 필요 없다. */
export interface InternalScenarioDto {
  id: string;
  symbols: string[];
  direction: ScenarioDirection;
  intensity: number;
  startsAtMs: number;
  endsAtMs: number;
}

interface ScenarioRow {
  id: string;
  symbols: string[];
  direction: string;
  intensity: number;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  canceledAt: Date | null;
  createdAt: Date;
}

/**
 * 관리자 시장 시나리오.
 *
 * 이 저장소의 어떤 공개 응답·소켓 채널에도 시나리오가 실리지 않는다. 읽는 쪽은
 * 관리자 화면과 내부 토큰을 가진 봇 프로세스뿐이다. 관리자가 아닌 호출에는 기능의
 * 존재 자체를 드러내지 않도록 403 대신 404를 돌려준다.
 */
@Injectable()
export class ScenarioService {
  constructor(@Inject(PRISMA) private prisma: PrismaClient) {}

  async list(userId: string): Promise<ScenarioDto[]> {
    await this.assertAdmin(userId);
    const rows = await this.prisma.marketScenario.findMany({
      orderBy: { startsAt: "desc" },
      take: 50,
    });
    return rows.map(toDto);
  }

  async create(userId: string, nickname: string, dto: CreateScenarioDto, nowMs = Date.now()): Promise<ScenarioDto> {
    await this.assertAdmin(userId);
    const input = parseScenario(dto, nowMs);
    const row = await this.prisma.marketScenario.create({
      data: { ...input, createdBy: nickname },
    });
    return toDto(row);
  }

  async cancel(userId: string, id: string): Promise<ScenarioDto> {
    await this.assertAdmin(userId);
    const existing = await this.prisma.marketScenario.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("없는 시나리오입니다");
    if (existing.canceledAt) return toDto(existing);
    const row = await this.prisma.marketScenario.update({
      where: { id },
      data: { canceledAt: new Date() },
    });
    return toDto(row);
  }

  /** 봇 전용: 진행 중이거나 곧 시작할, 취소되지 않은 시나리오. */
  async internalActive(token: string | undefined, nowMs = Date.now()): Promise<InternalScenarioDto[]> {
    assertInternalToken(token);
    const rows = await this.prisma.marketScenario.findMany({
      where: {
        canceledAt: null,
        endsAt: { gt: new Date(nowMs) },
        startsAt: { lt: new Date(nowMs + INTERNAL_LOOKAHEAD_MS) },
      },
      orderBy: { startsAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      symbols: row.symbols,
      direction: row.direction as ScenarioDirection,
      intensity: row.intensity,
      startsAtMs: row.startsAt.getTime(),
      endsAtMs: row.endsAt.getTime(),
    }));
  }

  private async assertAdmin(userId: string) {
    const caller = await this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!caller?.isAdmin) throw new NotFoundException();
  }
}

export function parseScenario(dto: CreateScenarioDto, nowMs: number) {
  if (!Array.isArray(dto.symbols) || dto.symbols.length === 0) {
    throw new BadRequestException("종목을 하나 이상 고르세요");
  }
  const symbols = [...new Set(dto.symbols)];
  for (const symbol of symbols) {
    if (typeof symbol !== "string" || !ACTIVE_SYMBOLS.has(symbol)) {
      throw new BadRequestException(`없는 종목: ${String(symbol)}`);
    }
  }

  if (dto.direction !== "UP" && dto.direction !== "DOWN") {
    throw new BadRequestException("방향은 UP 또는 DOWN 입니다");
  }
  const intensity = Number(dto.intensity);
  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 3) {
    throw new BadRequestException("강도는 1~3 입니다");
  }

  const startsAt = parseDate(dto.startsAt, "시작 시각");
  const endsAt = parseDate(dto.endsAt, "종료 시각");
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration < MIN_SCENARIO_DURATION_MS) throw new BadRequestException("기간은 5분 이상이어야 합니다");
  if (duration > MAX_SCENARIO_DURATION_MS) throw new BadRequestException("기간은 24시간 이하여야 합니다");
  if (startsAt.getTime() < nowMs - START_GRACE_MS) throw new BadRequestException("시작 시각이 이미 지났습니다");
  if (startsAt.getTime() > nowMs + MAX_SCENARIO_LEAD_MS) {
    throw new BadRequestException("시작 시각은 7일 이내여야 합니다");
  }

  return {
    symbols: symbols as string[],
    direction: dto.direction as ScenarioDirection,
    intensity,
    startsAt,
    endsAt,
  };
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new BadRequestException(`${field}이 필요합니다`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} 형식이 올바르지 않습니다`);
  return date;
}

function assertInternalToken(presentedToken: string | undefined) {
  const expected = Buffer.from(liquidityBootstrapToken());
  const presented = Buffer.from(presentedToken ?? "");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new UnauthorizedException("invalid liquidity bootstrap token");
  }
}

function toDto(row: ScenarioRow): ScenarioDto {
  return {
    id: row.id,
    symbols: row.symbols,
    direction: row.direction as ScenarioDirection,
    intensity: row.intensity,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    createdBy: row.createdBy,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
