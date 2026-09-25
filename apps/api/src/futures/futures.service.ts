import { Inject, Injectable, Optional } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  FUTURES,
  futureMaintenanceMargin,
  indexLevel,
  KEYS,
  REFERENCE_ASSETS,
  type FutureDef,
  type ReferenceTick,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { koreaSessionStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { PRISMA, REDIS } from "../core/tokens";
import { futuresEncumbrance } from "../order/futures-margin";

const OVERVIEW_TTL_MS = 2_000;

export interface FutureOverviewRow {
  symbol: string;
  name: string;
  unit: string;
  priceScale: number;
  decimals: number;
  tickUnits: number;
  unitValue: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  /** 선물 최근 체결가(정수 단위) */
  lastPrice: number;
  /** 오늘(09:00 KST 이후) 첫 체결가, 없으면 직전 체결가, 없으면 상장가 */
  base: number;
  /** 기초자산 현재값(정수 단위, 선물과 같은 scale). 아직 없으면 null */
  underlying: number | null;
  volume: number;
}

@Injectable()
export class FuturesService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  /** 선물 5종 시세 + 기초자산. 모든 접속자가 같은 값이라 2초 공유한다. */
  async overview(): Promise<FutureOverviewRow[]> {
    const session = koreaSessionStart();
    return this.cache.getOrCompute(`futures:overview:${session.getTime()}`, OVERVIEW_TTL_MS, async () => {
      const symbols = FUTURES.map((future) => future.symbol);
      const [rows, stats, underlying] = await Promise.all([
        this.prisma.marketSymbol.findMany({ where: { symbol: { in: symbols } } }),
        this.prisma.$queryRaw<{ symbol: string; opening: number | null; previous: number | null; volume: bigint }[]>`
          SELECT s.symbol,
            (SELECT t.price FROM matching.trades t WHERE t.symbol = s.symbol AND t.created_at >= ${session}
              ORDER BY t.created_at ASC, t.id ASC LIMIT 1) AS opening,
            (SELECT t.price FROM matching.trades t WHERE t.symbol = s.symbol AND t.created_at < ${session}
              ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS previous,
            COALESCE((SELECT SUM(t.qty) FROM matching.trades t WHERE t.symbol = s.symbol AND t.created_at >= ${session}), 0) AS volume
          FROM market.symbols s WHERE s.kind = 'FUTURE'
        `,
        this.underlyingUnits(),
      ]);
      const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
      const statBySymbol = new Map(stats.map((row) => [row.symbol, row]));
      return FUTURES.map((future) => {
        const row = bySymbol.get(future.symbol);
        const stat = statBySymbol.get(future.symbol);
        return {
          symbol: future.symbol,
          name: future.name,
          unit: future.unit,
          priceScale: future.priceScale,
          decimals: future.decimals,
          tickUnits: future.tickUnits,
          unitValue: future.unitValue,
          initialMarginBps: future.initialMarginBps,
          maintenanceMarginBps: future.maintenanceMarginBps,
          lastPrice: row?.lastPrice ?? future.initialPrice,
          base: stat?.opening ?? stat?.previous ?? row?.initialPrice ?? future.initialPrice,
          underlying: underlying.get(future.symbol) ?? null,
          volume: Number(stat?.volume ?? 0),
        };
      });
    });
  }

  /** 기초자산 현재값을 선물과 같은 정수 단위로. KABU 지수는 현물 최근가와 지수 구간으로 계산한다. */
  async underlyingUnits(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const [latest, epoch, stocks] = await Promise.all([
      this.redis.mget(...REFERENCE_ASSETS.map((asset) => KEYS.referenceLatest(asset.code))),
      this.prisma.indexEpoch.findFirst({ orderBy: { startsAt: "desc" } }),
      this.prisma.marketSymbol.findMany({ where: { kind: "STOCK" }, select: { symbol: true, lastPrice: true, listedShares: true } }),
    ]);
    const refByCode = new Map<string, number>();
    REFERENCE_ASSETS.forEach((asset, index) => {
      const raw = latest[index];
      if (!raw) return;
      try {
        const tick = JSON.parse(raw) as ReferenceTick;
        if (Number.isFinite(tick.value)) refByCode.set(asset.code, tick.value / asset.scale);
      } catch {
        // 깨진 값은 건너뛴다 — 다음 1초 발행이 덮어쓴다.
      }
    });
    let kabuIndex: number | null = null;
    if (epoch && epoch.divisor > 0) {
      const price = new Map(stocks.map((s) => [s.symbol, s.lastPrice]));
      const shares = new Map(stocks.map((s) => [s.symbol, Number(s.listedShares)]));
      kabuIndex = indexLevel(epoch, (symbol) => price.get(symbol) ?? 0, (symbol) => shares.get(symbol) ?? 0);
    }
    for (const future of FUTURES) {
      const value = future.underlying === "KABU_INDEX" ? kabuIndex : (refByCode.get(future.underlying) ?? null);
      if (value != null && Number.isFinite(value)) result.set(future.symbol, Math.round(value * future.priceScale));
    }
    return result;
  }

  /** 내 선물 포지션: 평균가·평가손익·증거금, 계좌 전체의 유지증거금 대비 여유. */
  async positions(accountId: string) {
    const [positions, overview, encumbrance, account] = await Promise.all([
      this.prisma.futuresPosition.findMany({ where: { accountId, qty: { not: 0 } } }),
      this.overview(),
      futuresEncumbrance(this.prisma, accountId),
      this.prisma.account.findUnique({ where: { id: accountId }, select: { balance: true, holdAmount: true } }),
    ]);
    const markBySymbol = new Map(overview.map((row) => [row.symbol, row.lastPrice]));
    let unrealizedTotal = 0n;
    let maintenanceTotal = 0n;
    const rows = positions.map((position) => {
      const def = FUTURES.find((future) => future.symbol === position.symbol) as FutureDef;
      const mark = markBySymbol.get(position.symbol) ?? def.initialPrice;
      const qty = position.qty;
      const markValue = BigInt(Math.abs(qty)) * BigInt(mark);
      const direction = qty > 0 ? 1n : -1n;
      const unrealized = direction * (markValue - position.entryValue) * BigInt(def.unitValue);
      const maintenance = futureMaintenanceMargin(def, qty, mark);
      unrealizedTotal += unrealized;
      maintenanceTotal += maintenance;
      return {
        symbol: position.symbol,
        qty,
        avgPrice: Number(position.entryValue) / Math.abs(qty),
        markPrice: mark,
        unrealized,
        marginHeld: position.marginHeld,
        maintenanceMargin: maintenance,
      };
    });
    // 평가예탁금 = 현금 + 평가손익 − 미수금. 유지증거금보다 작으면 추가증거금 대상(4단계에서 반대매매).
    const equity = (account?.balance ?? 0n) + unrealizedTotal - encumbrance.debt;
    return {
      positions: rows,
      marginHeld: encumbrance.margin,
      debt: encumbrance.debt,
      unrealized: unrealizedTotal,
      maintenanceMargin: maintenanceTotal,
      equity,
    };
  }
}
