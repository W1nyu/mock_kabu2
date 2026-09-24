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

/** 겹쳐서 뒤로 밀렸다면 원래 요청한 시작 시각을 함께 돌려준다. */
export interface CreatedScenarioDto extends ScenarioDto {
  requestedStartsAt: string | null;
}

/** 시나리오 등록을 직렬화하는 pg advisory lock 키 (임의의 고정값). */
const SCENARIO_LOCK_KEY = 725_300_001;

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

  /**
   * A symbol runs at most one scenario at a time. A new scenario that would
   * overlap a pending or running one on any of its symbols keeps its duration
   * and starts when the last conflicting one ends. The advisory lock makes two
   * simultaneous submissions queue instead of both claiming the same slot.
   */
  async create(userId: string, nickname: string, dto: CreateScenarioDto, nowMs = Date.now()): Promise<CreatedScenarioDto> {
    await this.assertAdmin(userId);
    const input = parseScenario(dto, nowMs);
    const durationMs = input.endsAt.getTime() - input.startsAt.getTime();

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCENARIO_LOCK_KEY})`;
      const conflicts = await tx.marketScenario.findMany({
        where: { canceledAt: null, endsAt: { gt: input.startsAt }, symbols: { hasSome: input.symbols } },
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, endsAt: true },
      });
      const startsAtMs = firstFreeStart(input.startsAt.getTime(), durationMs, conflicts);
      if (startsAtMs > nowMs + MAX_SCENARIO_LEAD_MS) {
        throw new BadRequestException("앞선 시나리오 뒤로 미루면 7일을 넘습니다");
      }
      return tx.marketScenario.create({
        data: {
          ...input,
          startsAt: new Date(startsAtMs),
          endsAt: new Date(startsAtMs + durationMs),
          createdBy: nickname,
        },
      });
    });

    const shifted = row.startsAt.getTime() !== input.startsAt.getTime();
    return { ...toDto(row), requestedStartsAt: shifted ? input.startsAt.toISOString() : null };
  }

  /** Only a canceled or finished scenario can be removed; a pending or live one must be canceled first. */
  async remove(userId: string, id: string, nowMs = Date.now()): Promise<{ id: string }> {
    await this.assertAdmin(userId);
    const existing = await this.prisma.marketScenario.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("없는 시나리오입니다");
    if (!existing.canceledAt && existing.endsAt.getTime() > nowMs) {
      throw new BadRequestException("취소했거나 종료된 시나리오만 삭제할 수 있습니다");
    }
    await this.prisma.marketScenario.delete({ where: { id } });
    return { id };
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

/**
 * Earliest start at or after `requestedMs` whose window overlaps none of
 * `taken`. `taken` must be sorted by start; one pass suffices because the
 * candidate only moves later.
 */
export function firstFreeStart(
  requestedMs: number,
  durationMs: number,
  taken: readonly { startsAt: Date; endsAt: Date }[],
): number {
  let start = requestedMs;
  for (const window of taken) {
    const windowStart = window.startsAt.getTime();
    const windowEnd = window.endsAt.getTime();
    if (windowStart < start + durationMs && windowEnd > start) start = windowEnd;
  }
  return start;
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
