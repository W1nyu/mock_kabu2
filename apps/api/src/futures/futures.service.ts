import { BadRequestException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import { Prisma, type PrismaClient } from "@mock-kabu/db";
import {
  FUTURES,
  futureDef,
  futureMarkPrice,
  futureMaintenanceMargin,
  isValidLeverage,
  MAX_FUTURES_LEVERAGE,
  futureMarginPerContract,
  futureUnrealized,
  indexLevel,
  KEYS,
  REFERENCE_ASSETS,
  type FutureDef,
  type ReferenceTick,
} from "@mock-kabu/shared";
import type Redis from "ioredis";
import { koreaSessionStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { BALANCE_MUTATOR, PRISMA, REDIS } from "../core/tokens";
import { futuresEncumbrance } from "../order/futures-margin";

const OVERVIEW_TTL_MS = 2_000;
/** 평가가격은 반대매매 감시(5초)와 포지션 조회가 같이 쓴다 — 2초 공유 */
const MARK_TTL_MS = 2_000;
/** 평가가격에 넣는 최근 체결 범위 */
const MARK_RECENT_WINDOW = "5 minutes";
const MARK_RECENT_TRADES = 10;

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
    @Optional() @Inject(BALANCE_MUTATOR) private mutator?: BalanceMutator,
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

  /**
   * 반대매매·추가증거금 평가가격(정수 단위) — futureMarkPrice(기초자산 · 최근 체결 중앙값 · 최근가의 중앙값).
   * 작은 거래 한 건이 최근가를 튀게 해도 평가가격은 흔들리지 않는다.
   */
  async marks(): Promise<Map<string, number>> {
    return this.cache.getOrCompute("futures:marks", MARK_TTL_MS, async () => {
      const symbols = FUTURES.map((future) => future.symbol);
      const [rows, recent, underlying] = await Promise.all([
        this.prisma.marketSymbol.findMany({ where: { kind: "FUTURE" }, select: { symbol: true, lastPrice: true } }),
        this.prisma.$queryRaw<{ symbol: string; price: number }[]>`
          SELECT symbol, price FROM (
            SELECT symbol, price, row_number() OVER (PARTITION BY symbol ORDER BY created_at DESC, id DESC) AS rn
            FROM matching.trades
            WHERE symbol IN (${Prisma.join(symbols)}) AND created_at > now() - ${MARK_RECENT_WINDOW}::interval
          ) t WHERE rn <= ${MARK_RECENT_TRADES}
        `,
        this.underlyingUnits(),
      ]);
      const recentBySymbol = new Map<string, number[]>();
      for (const row of recent) recentBySymbol.set(row.symbol, [...(recentBySymbol.get(row.symbol) ?? []), Number(row.price)]);
      const lastBySymbol = new Map(rows.map((row) => [row.symbol, row.lastPrice]));
      const out = new Map<string, number>();
      for (const future of FUTURES) {
        const last = lastBySymbol.get(future.symbol) ?? future.initialPrice;
        out.set(
          future.symbol,
          futureMarkPrice({
            underlying: underlying.get(future.symbol) ?? null,
            recent: recentBySymbol.get(future.symbol) ?? [],
            last,
          }),
        );
      }
      return out;
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
    const [positionRows, marks, encumbrance, account, marginCall, liquidations] = await Promise.all([
      this.prisma.futuresPosition.findMany({ where: { accountId } }),
      this.marks(),
      futuresEncumbrance(this.prisma, accountId),
      this.prisma.account.findUnique({ where: { id: accountId }, select: { balance: true, holdAmount: true } }),
      this.prisma.futuresMarginCall.findFirst({ where: { accountId, resolvedAt: null } }),
      this.prisma.futuresLiquidation.findMany({ where: { accountId }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);
    // 평가손익·유지증거금은 반대매매 감시와 같은 평가가격으로(최근가 한 건이 아니라)
    const markBySymbol = marks;
    const positions = positionRows.filter((row) => row.qty !== 0);
    // 종목별 레버리지 설정(포지션이 없어도 설정 행이 있을 수 있다). null = 거래소 기준 증거금.
    const leverage: Record<string, number | null> = Object.fromEntries(FUTURES.map((future) => [future.symbol, null]));
    for (const row of positionRows) leverage[row.symbol] = row.leverage;
    let unrealizedTotal = 0n;
    let maintenanceTotal = 0n;
    let initialTotal = 0n;
    const rows = positions.map((position) => {
      const def = FUTURES.find((future) => future.symbol === position.symbol) as FutureDef;
      const mark = markBySymbol.get(position.symbol) ?? def.initialPrice;
      const qty = position.qty;
      const unrealized = futureUnrealized(def, qty, position.entryValue, mark);
      const maintenance = futureMaintenanceMargin(def, qty, mark, position.leverage);
      unrealizedTotal += unrealized;
      maintenanceTotal += maintenance;
      initialTotal += futureMarginPerContract(def, mark, position.leverage) * BigInt(Math.abs(qty));
      return {
        symbol: position.symbol,
        qty,
        avgPrice: Number(position.entryValue) / Math.abs(qty),
        markPrice: mark,
        unrealized,
        marginHeld: position.marginHeld,
        maintenanceMargin: maintenance,
        leverage: position.leverage,
      };
    });
    // 평가예탁금 = 현금 + 평가손익 − 미수금. 유지증거금보다 작으면 추가증거금(FuturesRiskService).
    const equity = (account?.balance ?? 0n) + unrealizedTotal - encumbrance.debt;
    return {
      positions: rows,
      marginHeld: encumbrance.margin,
      debt: encumbrance.debt,
      unrealized: unrealizedTotal,
      maintenanceMargin: maintenanceTotal,
      initialMargin: initialTotal,
      equity,
      leverage,
      /** 진행 중인 추가증거금. shortfall은 지금 기준으로 위탁증거금까지 더 채워야 할 금액 */
      marginCall: marginCall
        ? {
            startedAt: marginCall.startedAt,
            deadline: marginCall.deadline,
            required: marginCall.required,
            shortfall: initialTotal > equity ? initialTotal - equity : 0n,
          }
        : null,
      liquidations: liquidations.map((row) => ({
        orderId: row.orderId,
        symbol: row.symbol,
        side: row.side,
        qty: row.qty,
        reason: row.reason,
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * 종목 레버리지 설정(1~20배, null = 거래소 기준). 실제 증권사처럼 그 종목에 포지션이나 미체결 주문이 있으면
   * 바꿀 수 없다 — 이미 묶인 증거금과 새 증거금률이 섞이지 않게. 주문 접수와 같은 계좌 락 안에서 확인·저장한다.
   */
  async setLeverage(accountId: string, symbol: string, rawLeverage: unknown) {
    const def = futureDef(symbol);
    if (!def) throw new NotFoundException(`없는 선물: ${symbol}`);
    const leverage = rawLeverage == null ? null : Number(rawLeverage);
    if (!isValidLeverage(leverage)) {
      throw new BadRequestException(`레버리지는 1~${MAX_FUTURES_LEVERAGE}배 정수입니다`);
    }
    const apply = async (tx: { [key: string]: any }) => {
      const where = { accountId_symbol: { accountId, symbol } };
      const position = await tx.futuresPosition.findUnique({ where });
      if (position && position.qty !== 0) {
        throw new UnprocessableEntityException("포지션이 있는 동안에는 레버리지를 바꿀 수 없습니다. 청산한 뒤 바꿔 주세요");
      }
      const live = await tx.order.count({ where: { accountId, symbol, status: { in: ["OPEN", "PARTIAL"] } } });
      if (live > 0) throw new UnprocessableEntityException("미체결 주문이 있는 동안에는 레버리지를 바꿀 수 없습니다");
      await tx.futuresPosition.upsert({
        where,
        update: { leverage },
        create: { accountId, symbol, qty: 0, entryValue: 0n, marginHeld: 0n, leverage },
      });
    };
    if (this.mutator) await this.mutator.withAccountLock([accountId], (ctx) => apply(ctx.tx));
    else await this.prisma.$transaction((tx) => apply(tx));
    return { symbol, leverage };
  }
}
