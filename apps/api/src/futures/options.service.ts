import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  atmStrike,
  futuresTradingDay,
  nextFuturesSettlementAt,
  OPTION_FAMILIES,
  optionDef,
  OPTIONS,
  optionTheoretical,
  roundPremium,
  strikeForSlot,
  type OptionFamilyDef,
} from "@mock-kabu/shared";
import { MemoCache } from "../core/memo-cache";
import { PRISMA } from "../core/tokens";
import { FuturesService } from "./futures.service";

const OVERVIEW_TTL_MS = 2_000;
/** 행사가가 비어 있을 때 다시 깔아 보는 최소 간격 */
const ENSURE_RETRY_MS = 30_000;
const DAY_MS = 86_400_000;

export interface OptionRow {
  symbol: string;
  family: string;
  familyName: string;
  type: "CALL" | "PUT";
  slot: number;
  name: string;
  /** 오늘의 행사가(정수 단위). 아직 정해지지 않았으면 null */
  strike: number | null;
  /** 기초자산 현재값(정수 단위) */
  underlying: number | null;
  /** 블랙-숄즈 이론가(호가 단위로 반올림) */
  theo: number | null;
  lastPrice: number;
  priceScale: number;
  decimals: number;
  unit: string;
  tickUnits: number;
  unitValue: number;
  /** 만기(다음 04:11 KST) epoch ms */
  expiresAt: number;
}

/** 만기까지 남은 일수 */
export function daysToExpiry(now: number): number {
  return Math.max(0, (nextFuturesSettlementAt(now) - now) / DAY_MS);
}

/**
 * 1일물 옵션(설계 docs/superpowers/specs/2026-09-26-options-design.md):
 * 행사가 표(market.option_series) 관리, 이론가 시세, 보유 옵션 평가.
 */
@Injectable()
export class OptionsService implements OnModuleInit {
  private lastEnsureAt = 0;
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    private futures: FuturesService,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  onModuleInit() {
    // 처음 배포되거나 행사가가 비어 있으면 지금 기초자산으로 깐다(기초자산 값이 아직 없으면 다음 조회 때 다시).
    void this.ensureSeries().catch((error) => console.warn("[options] ensure series failed", error));
  }

  /** 행사가가 없는 옵션 계열에 지금 기초자산 기준으로 행사가를 깐다. */
  async ensureSeries(now = Date.now()): Promise<void> {
    const rows = await this.prisma.optionSeries.findMany();
    const have = new Set(rows.map((row) => row.symbol));
    const missing = OPTION_FAMILIES.filter((family) => OPTIONS.some((o) => o.family.code === family.code && !have.has(o.symbol)));
    if (missing.length === 0) return;
    const underlying = await this.futures.underlyingUnits();
    const prices = new Map<string, number>();
    for (const family of missing) {
      const value = underlying.get(family.future);
      if (value != null) prices.set(family.future, value);
    }
    await this.restrike(prices, now, missing);
  }

  /**
   * 계열마다 기초자산(prices: 선물 심볼 → 정수 단위) 기준 등가격 ±2 행사가를 깔고, 종목 최근가를 새 이론가로 둔다.
   * 매일 04:11 옵션 만기 정산 직후와 처음 배포 때 부른다.
   */
  async restrike(prices: ReadonlyMap<string, number>, now = Date.now(), families: readonly OptionFamilyDef[] = OPTION_FAMILIES) {
    const tradingDay = futuresTradingDay(nextFuturesSettlementAt(now));
    const days = daysToExpiry(now);
    for (const family of families) {
      const underlying = prices.get(family.future);
      if (underlying == null || !(underlying > 0)) continue;
      const atm = atmStrike(family, underlying);
      for (const option of OPTIONS.filter((o) => o.family.code === family.code)) {
        const strike = strikeForSlot(family, atm, option.slot);
        const theo = roundPremium(option, optionTheoretical({ type: option.type, underlying, strike, days, dailyVol: family.dailyVol }));
        await this.prisma.optionSeries.upsert({
          where: { symbol: option.symbol },
          update: { strike, tradingDay, updatedAt: new Date(now) },
          create: { symbol: option.symbol, strike, tradingDay },
        });
        await this.prisma.marketSymbol.update({ where: { symbol: option.symbol }, data: { lastPrice: theo } });
      }
    }
    this.cache.invalidate("options:");
  }

  /**
   * 행사가 거래일이 다음 만기와 다른(= 방금 만기가 지난) 계열만 다시 깐다. 만기 정산 뒤 부르며, 여러 번 불러도 같다.
   * @param loadPrices 필요할 때만 결제가(선물 심볼 → 정수 단위)를 가져온다.
   */
  async restrikeStale(loadPrices: () => Promise<ReadonlyMap<string, number>>, now = Date.now()): Promise<void> {
    const tradingDay = futuresTradingDay(nextFuturesSettlementAt(now));
    const rows = await this.prisma.optionSeries.findMany();
    const current = new Set(rows.filter((row) => row.tradingDay === tradingDay).map((row) => row.symbol));
    const stale = OPTION_FAMILIES.filter((family) => OPTIONS.some((o) => o.family.code === family.code && !current.has(o.symbol)));
    if (stale.length === 0) return;
    await this.restrike(await loadPrices(), now, stale);
  }

  /** 옵션 20종목 시세 — 행사가·기초자산·이론가·최근가. 모든 접속자가 같은 값이라 2초 공유한다. */
  async overview(now = Date.now()): Promise<OptionRow[]> {
    return this.cache.getOrCompute("options:overview", OVERVIEW_TTL_MS, async () => {
      const [series, symbols, underlying] = await Promise.all([
        this.prisma.optionSeries.findMany(),
        this.prisma.marketSymbol.findMany({ where: { kind: "OPTION" }, select: { symbol: true, lastPrice: true } }),
        this.futures.underlyingUnits(),
      ]);
      // 기동 때 행사가 깔기가 실패했으면(종목 seed 전 기동·기초자산 값 없음) 조회 쪽에서 가끔 다시 시도한다.
      if (series.length < OPTIONS.length && now - this.lastEnsureAt > ENSURE_RETRY_MS) {
        this.lastEnsureAt = now;
        void this.ensureSeries(now).catch((error) => console.warn("[options] ensure series retry failed", error));
      }
      const strikeBySymbol = new Map(series.map((row) => [row.symbol, row.strike]));
      const lastBySymbol = new Map(symbols.map((row) => [row.symbol, row.lastPrice]));
      const days = daysToExpiry(now);
      const expiresAt = nextFuturesSettlementAt(now);
      return OPTIONS.map((option) => {
        const strike = strikeBySymbol.get(option.symbol) ?? null;
        const s = underlying.get(option.family.future) ?? null;
        const theo =
          strike != null && s != null
            ? roundPremium(option, optionTheoretical({ type: option.type, underlying: s, strike, days, dailyVol: option.family.dailyVol }))
            : null;
        return {
          symbol: option.symbol,
          family: option.family.code,
          familyName: option.family.name,
          type: option.type,
          slot: option.slot,
          name: option.name,
          strike,
          underlying: s,
          theo,
          lastPrice: lastBySymbol.get(option.symbol) ?? option.tickUnits,
          priceScale: option.priceScale,
          decimals: option.decimals,
          unit: option.unit,
          tickUnits: option.tickUnits,
          unitValue: option.unitValue,
          expiresAt,
        };
      });
    });
  }

  /**
   * 내 옵션 포지션 — 평균가·이론가·평가액·평가손익. 평가액(최근가 × 수량 × 승수)은 총 자산에 들어간다.
   * 랭킹·자산 스냅샷(futuresValueSql)과 같은 값이 되도록 이론가가 아니라 최근 체결가로 평가한다.
   */
  async positions(accountId: string) {
    const [rows, overview] = await Promise.all([
      this.prisma.futuresPosition.findMany({
        where: { accountId, qty: { not: 0 }, symbol: { in: OPTIONS.map((o) => o.symbol) } },
      }),
      this.overview(),
    ]);
    const bySymbol = new Map(overview.map((row) => [row.symbol, row]));
    let value = 0n;
    const positions = rows.map((position) => {
      const def = optionDef(position.symbol)!;
      const row = bySymbol.get(position.symbol);
      const mark = row?.lastPrice ?? def.tickUnits;
      const positionValue = BigInt(position.qty) * BigInt(mark) * BigInt(def.unitValue);
      const cost = position.entryValue * BigInt(def.unitValue) * (position.qty > 0 ? 1n : -1n);
      value += positionValue;
      return {
        symbol: position.symbol,
        name: def.name,
        type: def.type,
        strike: row?.strike ?? null,
        qty: position.qty,
        avgPrice: Number(position.entryValue) / Math.abs(position.qty),
        lastPrice: mark,
        theo: row?.theo ?? null,
        value: positionValue,
        unrealized: positionValue - cost,
        marginHeld: position.marginHeld,
      };
    });
    return { positions, value };
  }
}
