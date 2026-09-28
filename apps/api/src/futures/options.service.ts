import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import {
  ALL_OPTIONS,
  atmStrike,
  extendStrikeLadder,
  futuresTradingDay,
  inOptionsRestrikeGap,
  nextFuturesSettlementAt,
  nextOptionsRestrikeAt,
  OPTION_FAMILIES,
  optionDef,
  OPTIONS,
  optionTheoretical,
  optionUnderlyingUnits,
  roundPremium,
  strikeForSlot,
  type OptionDef,
  type OptionFamilyDef,
} from "@mock-kabu/shared";
import { MemoCache } from "../core/memo-cache";
import { PRISMA } from "../core/tokens";
import { FuturesService } from "./futures.service";

const OVERVIEW_TTL_MS = 2_000;
/** 행사가가 비어 있을 때 다시 깔아 보는 최소 간격 */
const ENSURE_RETRY_MS = 30_000;
const DAY_MS = 86_400_000;
/** 04:20 점검 종료 뒤 봇이 다시 붙을 틈을 조금 두고 깐다 */
const RESTRIKE_DELAY_MS = 5_000;

export interface OptionRow {
  symbol: string;
  family: string;
  familyName: string;
  /** 거래 종료(보유분 매도·만기 정산만) — 체인·봇 호가에서 뺀다 */
  retired: boolean;
  /** 거래 종료 옵션의 마지막 만기가 지났다 — 더는 주문을 받지 않는다 */
  expired: boolean;
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

/**
 * 계열의 오늘 사다리가 온전한지 — 있는 행은 모두 오늘 거래일이고, 같은 자리의 콜·풋은 같은 행사가,
 * 자리마다 다른 행사가가 행사가 간격으로 빈틈없이 이어진다. 빈 자리(행사가 개수 확대)는 괜찮다.
 */
export function isContiguousLadder(
  family: Pick<OptionFamilyDef, "strikeStepUnits">,
  series: readonly Pick<OptionDef, "symbol" | "slot">[],
  bySymbol: ReadonlyMap<string, { strike: number; tradingDay: string }>,
  tradingDay: string,
): boolean {
  const strikeBySlot = new Map<number, number>();
  for (const option of series) {
    const row = bySymbol.get(option.symbol);
    if (!row) continue;
    if (row.tradingDay !== tradingDay) return false;
    const other = strikeBySlot.get(option.slot);
    if (other != null && other !== row.strike) return false;
    strikeBySlot.set(option.slot, row.strike);
  }
  const strikes = [...strikeBySlot.values()].sort((a, b) => a - b);
  for (let index = 1; index < strikes.length; index++) {
    if (strikes[index] - strikes[index - 1] !== family.strikeStepUnits) return false;
  }
  return true;
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
export class OptionsService implements OnModuleInit, OnModuleDestroy {
  private lastEnsureAt = 0;
  private restrikeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    private futures: FuturesService,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  onModuleInit() {
    // 처음 배포되거나 행사가가 비어 있으면 지금 기초자산으로 깐다(기초자산 값이 아직 없으면 다음 조회 때 다시).
    void this.ensureSeries().catch((error) => console.warn("[options] ensure series failed", error));
    this.scheduleRestrike();
  }

  onModuleDestroy() {
    if (this.restrikeTimer) clearTimeout(this.restrikeTimer);
  }

  /** 매일 04:20 KST(점검 종료) 그 시각 기초자산으로 만기가 지난 계열의 행사가를 깐다. */
  private scheduleRestrike() {
    const delay = Math.max(1_000, nextOptionsRestrikeAt(Date.now()) - Date.now() + RESTRIKE_DELAY_MS);
    this.restrikeTimer = setTimeout(() => {
      void this.ensureSeries()
        .catch((error) => console.warn("[options] daily restrike failed", error))
        .finally(() => this.scheduleRestrike());
    }, delay);
    this.restrikeTimer.unref?.();
  }

  /**
   * 행사가를 맞춘다. 만기 정산(04:11) 뒤 04:20 전에는 아무것도 하지 않는다 — 04:20 기초자산으로 깐다.
   *  - 계열에 오늘 거래일의 행사가가 하나도 없으면(만기가 지남·처음 배포) 지금 기초자산으로 전부 깐다(등가격 위아래 같은 개수).
   *  - 오늘 사다리가 깨져 있으면(한 칸 간격으로 이어지지 않음·간격 변경·콜/풋 행사가 불일치) 걸린 포지션·미체결 주문이
   *    없을 때만 전부 다시 깐다.
   *  - 오늘 행사가가 이미 있는데 종목만 늘었으면(행사가 개수 확대) 포지션이 걸린 기존 행사가는 그대로 두고,
   *    빈 종목에 사다리 바깥쪽 행사가를 붙인다. 다음 만기 뒤에는 정상 배치(가운데가 등가격)로 깐다.
   */
  async ensureSeries(now = Date.now()): Promise<void> {
    if (inOptionsRestrikeGap(now)) return;
    const rows = await this.prisma.optionSeries.findMany();
    const tradingDay = futuresTradingDay(nextFuturesSettlementAt(now));
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const restrikeAll: OptionFamilyDef[] = [];
    let underlying: Map<string, number> | null = null;
    for (const family of OPTION_FAMILIES) {
      const series = OPTIONS.filter((o) => o.family.code === family.code);
      const missing = series.filter((o) => !bySymbol.has(o.symbol));
      const current = series
        .map((o) => bySymbol.get(o.symbol))
        .filter((row): row is NonNullable<typeof row> => row != null && row.tradingDay === tradingDay);
      if (current.length === 0) {
        restrikeAll.push(family);
        continue;
      }
      if (!isContiguousLadder(family, series, bySymbol, tradingDay)) {
        if (await this.familyIsIdle(series.map((o) => o.symbol))) {
          console.warn(`[options] ${family.code} ladder is broken — re-laying around the money`);
          restrikeAll.push(family);
        }
        continue;
      }
      if (missing.length === 0) continue;
      underlying ??= await this.futures.underlyingUnits();
      const s = optionUnderlyingUnits(family, underlying);
      if (s == null) continue;
      const missingSlots = [...new Set(missing.map((o) => o.slot))].sort((a, b) => a - b);
      const added = extendStrikeLadder(family, [...new Set(current.map((row) => row.strike))], missingSlots.length);
      const days = daysToExpiry(now);
      for (const [index, slot] of missingSlots.entries()) {
        const strike = added[index];
        for (const option of series.filter((o) => o.slot === slot && !bySymbol.has(o.symbol))) {
          const theo = roundPremium(option, optionTheoretical({ type: option.type, underlying: s, strike, days, dailyVol: family.dailyVol }));
          await this.prisma.optionSeries.create({ data: { symbol: option.symbol, strike, tradingDay } });
          await this.prisma.marketSymbol.update({ where: { symbol: option.symbol }, data: { lastPrice: theo } });
        }
      }
      this.cache.invalidate("options:");
    }
    if (restrikeAll.length > 0) await this.restrike(underlying ?? (await this.futures.underlyingUnits()), now, restrikeAll);
  }

  /** 계열에 열린 포지션도 살아 있는 주문도 없다 — 행사가를 통째로 바꿔도 누구의 계약도 달라지지 않는다. */
  private async familyIsIdle(symbols: string[]): Promise<boolean> {
    const [positions, orders] = await Promise.all([
      this.prisma.futuresPosition.count({ where: { symbol: { in: symbols }, qty: { not: 0 } } }),
      this.prisma.order.count({ where: { symbol: { in: symbols }, status: { in: ["OPEN", "PARTIAL"] } } }),
    ]);
    return positions === 0 && orders === 0;
  }

  /**
   * 계열마다 기초자산 기준 등가격 ±(행사가 개수/2) 행사가를 깔고, 종목 최근가를 새 이론가로 둔다.
   * prices는 선물 심볼 → 기초자산(또는 결제가) 정수 단위 — 계열 기초자산은 구성 선물 값의 평균(optionUnderlyingUnits).
   * 매일 04:20(만기 정산 뒤 점검 종료)과 처음 배포 때 ensureSeries가 부른다. 종목 행이 아직 없으면(seed 전) 최근가만 건너뛴다.
   */
  async restrike(prices: ReadonlyMap<string, number>, now = Date.now(), families: readonly OptionFamilyDef[] = OPTION_FAMILIES) {
    const tradingDay = futuresTradingDay(nextFuturesSettlementAt(now));
    const days = daysToExpiry(now);
    for (const family of families) {
      if (family.retired) continue;
      const underlying = optionUnderlyingUnits(family, prices);
      if (underlying == null) continue;
      const atm = atmStrike(family, underlying);
      for (const option of OPTIONS.filter((o) => o.family.code === family.code)) {
        const strike = strikeForSlot(family, atm, option.slot);
        const theo = roundPremium(option, optionTheoretical({ type: option.type, underlying, strike, days, dailyVol: family.dailyVol }));
        await this.prisma.optionSeries.upsert({
          where: { symbol: option.symbol },
          update: { strike, tradingDay, updatedAt: new Date(now) },
          create: { symbol: option.symbol, strike, tradingDay },
        });
        await this.prisma.marketSymbol.updateMany({ where: { symbol: option.symbol }, data: { lastPrice: theo } });
      }
    }
    this.cache.invalidate("options:");
  }

  /** 옵션 시세(거래 종료 종목 포함, retired로 표시) — 행사가·기초자산·이론가·최근가. 모든 접속자가 같은 값이라 2초 공유한다. */
  async overview(now = Date.now()): Promise<OptionRow[]> {
    return this.cache.getOrCompute("options:overview", OVERVIEW_TTL_MS, async () => {
      const [series, symbols, underlying] = await Promise.all([
        this.prisma.optionSeries.findMany(),
        this.prisma.marketSymbol.findMany({ where: { kind: "OPTION" }, select: { symbol: true, lastPrice: true } }),
        this.futures.underlyingUnits(),
      ]);
      // 기동·04:20 깔기가 실패했으면(기초자산 값 없음 등) 조회 쪽에서 가끔 다시 시도한다 — 빠졌거나 지난 거래일 행사가.
      const liveDay = futuresTradingDay(nextFuturesSettlementAt(now));
      const liveDayBySymbol = new Map(series.map((row) => [row.symbol, row.tradingDay]));
      if (OPTIONS.some((o) => liveDayBySymbol.get(o.symbol) !== liveDay) && !inOptionsRestrikeGap(now) && now - this.lastEnsureAt > ENSURE_RETRY_MS) {
        this.lastEnsureAt = now;
        void this.ensureSeries(now).catch((error) => console.warn("[options] ensure series retry failed", error));
      }
      const strikeBySymbol = new Map(series.map((row) => [row.symbol, row.strike]));
      const dayBySymbol = new Map(series.map((row) => [row.symbol, row.tradingDay]));
      const currentDay = futuresTradingDay(nextFuturesSettlementAt(now));
      const lastBySymbol = new Map(symbols.map((row) => [row.symbol, row.lastPrice]));
      const days = daysToExpiry(now);
      const expiresAt = nextFuturesSettlementAt(now);
      return ALL_OPTIONS.map((option) => {
        const strike = strikeBySymbol.get(option.symbol) ?? null;
        const s = optionUnderlyingUnits(option.family, underlying);
        const theo =
          strike != null && s != null
            ? roundPremium(option, optionTheoretical({ type: option.type, underlying: s, strike, days, dailyVol: option.family.dailyVol }))
            : null;
        return {
          symbol: option.symbol,
          family: option.family.code,
          familyName: option.family.name,
          retired: option.family.retired === true,
          expired: option.family.retired === true && (dayBySymbol.get(option.symbol) ?? "") < currentDay,
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
        where: { accountId, qty: { not: 0 }, symbol: { in: ALL_OPTIONS.map((o) => o.symbol) } },
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
