import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  MACRO_CYCLE_DRIVERS,
  type MacroCyclePhase,
  type MarketCyclePhase,
  type MarketCycleReport,
} from "@mock-kabu/shared";
import { PRISMA } from "../core/tokens";
import { assertInternalToken } from "./scenario.service";

const MARKET_PHASES: readonly MarketCyclePhase[] = ["BULL", "BEAR", "SIDEWAYS"];
const DRIVER_PHASES: readonly MacroCyclePhase[] = ["RISING", "FALLING", "STEADY"];

/**
 * 봇이 1분마다 보내는 자동 장세의 지금 국면. 관리자 화면 전용이라 메모리에 마지막 것만 둔다 —
 * API가 재시작하면 다음 보고(1분 안)까지 비어 있다. 공개 응답·소켓 어디에도 싣지 않는다.
 */
@Injectable()
export class MarketCycleService {
  private latest: MarketCycleReport | null = null;

  constructor(@Inject(PRISMA) private prisma: PrismaClient) {}

  /** 봇 전용 */
  receive(token: string | undefined, body: unknown): { ok: true } {
    assertInternalToken(token);
    this.latest = parseMarketCycleReport(body);
    return { ok: true };
  }

  /** 관리자 전용 — 아니면 기능을 드러내지 않도록 404 */
  async current(userId: string): Promise<{ report: MarketCycleReport | null }> {
    const caller = await this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!caller?.isAdmin) throw new NotFoundException();
    return { report: this.latest };
  }
}

function finite(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new BadRequestException(`invalid ${field}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new BadRequestException(`invalid ${field}`);
  return value as T;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`invalid ${field}`);
  return value as Record<string, unknown>;
}

/** 봇 보고를 알려진 필드만 골라 검증한다(남는 필드는 버린다). */
export function parseMarketCycleReport(body: unknown): MarketCycleReport {
  const root = record(body, "report");
  const market = record(root.market, "market");
  const drivers = record(root.drivers, "drivers");
  const valuation = record(root.valuation, "valuation");
  return {
    reportedAtMs: finite(root.reportedAtMs, "reportedAtMs", 0),
    market: {
      phase: oneOf(market.phase, MARKET_PHASES, "market.phase"),
      sinceMs: finite(market.sinceMs, "market.sinceMs", 0),
      cycleLean: finite(market.cycleLean, "market.cycleLean", -1, 1),
      lean: finite(market.lean, "market.lean", -1, 1),
      positiveShare: finite(market.positiveShare, "market.positiveShare", 0, 1),
    },
    drivers: Object.fromEntries(
      MACRO_CYCLE_DRIVERS.map((driver) => {
        const state = record(drivers[driver], `drivers.${driver}`);
        return [
          driver,
          {
            phase: oneOf(state.phase, DRIVER_PHASES, `drivers.${driver}.phase`),
            sinceMs: finite(state.sinceMs, `drivers.${driver}.sinceMs`, 0),
            lean: finite(state.lean, `drivers.${driver}.lean`, -1, 1),
          },
        ];
      }),
    ) as MarketCycleReport["drivers"],
    valuation: {
      index: valuation.index == null ? null : finite(valuation.index, "valuation.index", 0),
      fairIndex: finite(valuation.fairIndex, "valuation.fairIndex", 0),
      pull: finite(valuation.pull, "valuation.pull", -1, 1),
    },
  };
}
