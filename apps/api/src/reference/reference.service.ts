import { timingSafeEqual } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException, Optional, UnauthorizedException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@mock-kabu/db";
import {
  candleIntervalSeconds,
  CHANNELS,
  ROLLUP_CANDLE_INTERVAL,
  ROLLUP_CANDLE_SECONDS,
  KEYS,
  REFERENCE_ASSETS,
  referenceAsset,
  type ReferenceTick,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { mapWithConcurrency } from "../common/map-with-concurrency";
import { koreaSessionStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { PRISMA, REDIS } from "../core/tokens";
import { liquidityBootstrapToken } from "../liquidity/liquidity-reserve";

const BASE_INTERVAL = "1m";
const OVERVIEW_TTL_MS = 5_000;
const OVERVIEW_CONCURRENCY = 3;
const CANDLE_TTL_MS = 2_000;
/** 1분봉으로 쓰는 값은 실제값 × scale 정수. 이 범위를 벗어난 값은 봇 오류로 보고 버린다. */
const MAX_UNITS = 2_000_000_000;
/** 봇이 보낸 시각이 서버 시각과 이보다 멀면 거부한다(오래된 재전송·시계 오류). */
const MAX_CLOCK_SKEW_MS = 60_000;

export interface PublishReferenceDto {
  ts?: unknown;
  prices?: unknown;
}

export interface ReferenceOverviewRow {
  code: string;
  name: string;
  unit: string;
  scale: number;
  decimals: number;
  /** 최신값(저장 정수), 아직 없으면 null */
  value: number | null;
  ts: number | null;
  /** 09:00 KST 이후 첫 1분봉 시가, 없으면 직전 종가 — 오늘 등락의 기준 */
  base: number | null;
  /** 최근 6시간 5분봉 종가(저장 정수) */
  spark: number[];
}

@Injectable()
export class ReferenceService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  /** 봇 전용: 1초마다 전 기초자산의 최신값을 받는다. Redis 최신값·소켓 발행·1분봉 갱신. */
  async publish(token: string | undefined, dto: PublishReferenceDto): Promise<{ accepted: number }> {
    this.assertToken(token);
    const ts = Number(dto.ts);
    if (!Number.isFinite(ts) || Math.abs(ts - Date.now()) > MAX_CLOCK_SKEW_MS) {
      throw new BadRequestException("ts must be a current epoch-ms timestamp");
    }
    if (!dto.prices || typeof dto.prices !== "object") throw new BadRequestException("prices must be an object");

    const ticks: ReferenceTick[] = [];
    for (const [code, raw] of Object.entries(dto.prices as Record<string, unknown>)) {
      const def = referenceAsset(code);
      const value = Number(raw);
      if (!def) throw new BadRequestException(`unknown reference: ${code}`);
      if (!Number.isInteger(value) || value <= 0 || value > MAX_UNITS) {
        throw new BadRequestException(`invalid value for ${code}`);
      }
      ticks.push({ code: def.code, value, ts });
    }
    if (ticks.length === 0) return { accepted: 0 };

    const bucket = new Date(Math.floor(ts / 60_000) * 60_000);
    const rows = Prisma.join(
      ticks.map((tick) => Prisma.sql`(${tick.code}, ${BASE_INTERVAL}, ${bucket}, ${tick.value}, ${tick.value}, ${tick.value}, ${tick.value})`),
    );
    await this.prisma.$executeRaw`
      INSERT INTO market.reference_candles (code, interval, ts, open, high, low, close)
      VALUES ${rows}
      ON CONFLICT (code, interval, ts) DO UPDATE SET
        high = GREATEST(market.reference_candles.high, EXCLUDED.high),
        low = LEAST(market.reference_candles.low, EXCLUDED.low),
        close = EXCLUDED.close
    `;

    const pipeline = this.redis.pipeline();
    for (const tick of ticks) {
      const json = JSON.stringify(tick);
      pipeline.set(KEYS.referenceLatest(tick.code), json);
      pipeline.publish(CHANNELS.reference(tick.code), json);
    }
    await pipeline.exec();
    return { accepted: ticks.length };
  }

  /** 전 기초자산 최신값 + 오늘 기준값 + 미니 추세선. 모든 접속자가 같은 값이라 5초 공유한다. */
  async overview(): Promise<ReferenceOverviewRow[]> {
    const session = koreaSessionStart();
    return this.cache.getOrCompute(`reference:overview:${session.getTime()}`, OVERVIEW_TTL_MS, async () => {
      const latest = await this.redis.mget(...REFERENCE_ASSETS.map((asset) => KEYS.referenceLatest(asset.code)));
      // 자산마다 쿼리 2개 — 한꺼번에 보내지 않고 몇 개씩만(커넥션 풀 독점 방지).
      return mapWithConcurrency([...REFERENCE_ASSETS.entries()], OVERVIEW_CONCURRENCY, async ([index, asset]) => {
        const tick = parseTick(latest[index]);
        const [base, spark] = await Promise.all([
          this.sessionBase(asset.code, session),
          this.aggregate(asset.code, 300, 72),
        ]);
        return {
          code: asset.code,
          name: asset.name,
          unit: asset.unit,
          scale: asset.scale,
          decimals: asset.decimals,
          value: tick?.value ?? spark.at(-1)?.close ?? null,
          ts: tick?.ts ?? null,
          base,
          spark: spark.map((row) => row.close),
        };
      });
    });
  }

  /** 기초자산 봉. 1분봉만 저장하고 나머지 간격은 조회 때 묶는다(현물 봉과 같은 방식). */
  async candles(code: string, interval: string, limit: number) {
    const def = referenceAsset(code);
    if (!def) throw new NotFoundException(`없는 기초자산: ${code}`);
    const seconds = candleIntervalSeconds(interval);
    if (seconds === null) throw new NotFoundException(`지원하지 않는 봉 간격: ${interval}`);
    const take = Math.min(Math.max(1, Number(limit) || 180), 1000);
    return this.cache.getOrCompute(`reference:candles:${def.code}:${seconds}:${take}`, CANDLE_TTL_MS, () =>
      this.aggregate(def.code, seconds, take),
    );
  }

  private async aggregate(code: string, seconds: number, take: number) {
    const windowSeconds = seconds * take * 3;
    // 30일 지난 1분봉은 1시간봉으로 합쳐져 있다(prune-history). 1시간 이상 간격은 둘을 함께 읽는다.
    const sources =
      seconds >= ROLLUP_CANDLE_SECONDS && seconds % ROLLUP_CANDLE_SECONDS === 0
        ? Prisma.sql`IN (${BASE_INTERVAL}, ${ROLLUP_CANDLE_INTERVAL})`
        : Prisma.sql`= ${BASE_INTERVAL}`;
    const rows = await this.prisma.$queryRaw<{ ts: Date; open: number; high: number; low: number; close: number }[]>`
      WITH latest AS (
        SELECT max(ts) AS ts FROM market.reference_candles WHERE code = ${code} AND interval = ${BASE_INTERVAL}
      )
      SELECT
        to_timestamp(floor(extract(epoch FROM c.ts) / ${seconds}) * ${seconds}) AT TIME ZONE 'UTC' AS ts,
        (array_agg(c.open ORDER BY c.ts ASC))[1] AS open,
        max(c.high) AS high,
        min(c.low) AS low,
        (array_agg(c.close ORDER BY c.ts DESC))[1] AS close
      FROM market.reference_candles c, latest
      WHERE c.code = ${code} AND c.interval ${sources}
        AND c.ts > latest.ts - make_interval(secs => ${windowSeconds}::double precision)
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${take}
    `;
    return rows.reverse().map((row) => ({
      ts: row.ts,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));
  }

  private async sessionBase(code: string, session: Date): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<{ base: number | null }[]>`
      SELECT COALESCE(
        (SELECT open FROM market.reference_candles
          WHERE code = ${code} AND interval = ${BASE_INTERVAL} AND ts >= ${session} ORDER BY ts ASC LIMIT 1),
        (SELECT close FROM market.reference_candles
          WHERE code = ${code} AND interval = ${BASE_INTERVAL} AND ts < ${session} ORDER BY ts DESC LIMIT 1)
      ) AS base
    `;
    return row?.base == null ? null : Number(row.base);
  }

  private assertToken(presented: string | undefined) {
    const expected = Buffer.from(liquidityBootstrapToken());
    const actual = Buffer.from(presented ?? "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException("invalid liquidity bootstrap token");
    }
  }
}

function parseTick(raw: string | null | undefined): ReferenceTick | null {
  if (!raw) return null;
  try {
    const tick = JSON.parse(raw) as ReferenceTick;
    return Number.isFinite(tick.value) ? tick : null;
  } catch {
    return null;
  }
}
