import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { BackgroundStatusRegistry } from "../core/background-status";
import { PRISMA } from "../core/tokens";

const SNAPSHOT_INTERVAL_MS = 60_000;
/** 하루 한 번 오래된 1분 행을 솎아낸다. 7일 지나면 10분 격자만, 90일 지나면 1시간 격자만 남긴다. */
const COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COMPACT_TIERS: { olderThanMs: number; keepEverySeconds: number }[] = [
  { olderThanMs: 7 * 24 * 60 * 60 * 1000, keepEverySeconds: 600 },
  { olderThanMs: 90 * 24 * 60 * 60 * 1000, keepEverySeconds: 3_600 },
];

export type EquityRange = "1d" | "1w" | "all";

export interface DailyPerformance {
  /** KST 기준 날짜 YYYY-MM-DD */
  date: string;
  closeEquity: number | null;
  closeCash: number | null;
  /** 전일 종가 자산 대비 증감. 전일 스냅샷이 없으면 null */
  change: number | null;
  changeRate: number | null;
  realized: number;
  fills: number;
}

export interface EquityPoint {
  ts: number;
  cash: number;
  stockValue: number;
  equity: number;
}

/** 조회 구간별 버킷 폭(초). 1일은 원본 1분, 그 이상은 굵게 묶어 포인트 수를 제한한다. */
const BUCKET_SECONDS: Record<EquityRange, number> = { "1d": 60, "1w": 600, all: 3_600 };
const RANGE_MS: Record<EquityRange, number | null> = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * 사용자 계정의 분 단위 자산 스냅샷. 봇 계정은 유동성 풀이라 추이가 의미 없어 제외한다.
 * 한 SQL로 모든 사용자 계정을 한 번에 기록하고, (account_id, ts) 유니크로 다중 인스턴스
 * 중복 기록을 무시한다.
 */
@Injectable()
export class EquitySnapshotService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastSnapshotAt: number | null = null;
  private lastInserted = 0;
  private lastError: string | null = null;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Optional() private background?: BackgroundStatusRegistry,
  ) {}

  onModuleInit() {
    this.background?.register("equitySnapshots", () => ({
      // 2분 넘게 스냅샷이 없으면 스케줄러가 멈춘 것이다.
      status:
        this.lastSnapshotAt == null
          ? "starting"
          : Date.now() - this.lastSnapshotAt > 2 * SNAPSHOT_INTERVAL_MS
            ? "degraded"
            : "up",
      lastSnapshotAt: this.lastSnapshotAt ? new Date(this.lastSnapshotAt).toISOString() : null,
      lastInserted: this.lastInserted,
      lastError: this.lastError,
    }));
    // 즉시 한 번 찍고, 그 뒤로는 매 분 경계에 맞춰 기록한다.
    void this.snapshot();
    this.scheduleNext();
    void this.compact();
    this.compactTimer = setInterval(() => void this.compact(), COMPACT_INTERVAL_MS);
  }

  onModuleDestroy() {
    this.background?.unregister("equitySnapshots");
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.compactTimer) clearInterval(this.compactTimer);
  }

  /**
   * 조회 버킷(1w=10분, all=1시간)이 "버킷의 마지막 행"을 쓰므로, 각 버킷의 마지막 1분 행
   * (예: 10분 격자면 :09, :19, …, 1시간 격자면 :59)만 남기면 과거 구간의 차트 모양이 유지된다.
   * 1시간 격자의 :59는 10분 격자에도 속하므로 두 단계가 서로를 지우지 않는다.
   */
  async compact(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const tier of COMPACT_TIERS) {
      const before = new Date(now - tier.olderThanMs);
      try {
        removed += await this.prisma.$executeRaw`
          DELETE FROM account.equity_snapshots
          WHERE ts < ${before}
            AND ((floor(extract(epoch FROM ts))::bigint + 60) % ${tier.keepEverySeconds}) <> 0
        `;
      } catch (error) {
        console.error("[equity] compaction failed", error);
      }
    }
    if (removed > 0) console.log(`[equity] compacted ${removed} old snapshot rows`);
    return removed;
  }

  private scheduleNext() {
    if (this.stopped) return;
    const now = Date.now();
    const delay = SNAPSHOT_INTERVAL_MS - (now % SNAPSHOT_INTERVAL_MS) + 250;
    this.timer = setTimeout(() => {
      void this.snapshot().finally(() => this.scheduleNext());
    }, delay);
  }

  async snapshot(now = new Date()): Promise<number> {
    const ts = new Date(Math.floor(now.getTime() / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS);
    try {
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO account.equity_snapshots (account_id, ts, cash, stock_value, equity)
        SELECT
          a.id,
          ${ts},
          a.balance,
          COALESCE(v.stock_value, 0),
          a.balance + COALESCE(v.stock_value, 0)
        FROM account.accounts a
        JOIN auth.users u ON u.id = a.user_id AND u.is_bot = false
        LEFT JOIN (
          SELECT h.account_id, SUM(h.qty::bigint * s.last_price) AS stock_value
          FROM account.holdings h
          JOIN market.symbols s ON s.symbol = h.symbol
          GROUP BY h.account_id
        ) v ON v.account_id = a.id
        ON CONFLICT (account_id, ts) DO NOTHING
      `;
      this.lastSnapshotAt = Date.now();
      this.lastInserted = inserted;
      this.lastError = null;
      return inserted;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[equity] snapshot failed", error);
      return 0;
    }
  }

  /**
   * KST 일별 성과. 하루의 마지막 스냅샷을 종가 자산으로, 전일 종가 대비 증감과 그날의
   * 실현손익·매도 체결 수를 합친다. 첫날은 전일이 없어 증감을 정의하지 않는다.
   */
  async daily(accountId: string, days = 30): Promise<DailyPerformance[]> {
    const take = Math.min(Math.max(1, days), 365);
    const rows = await this.prisma.$queryRaw<
      {
        day: Date;
        close_equity: bigint | null;
        close_cash: bigint | null;
        realized: bigint;
        fills: bigint;
      }[]
    >`
      WITH eq AS (
        SELECT DISTINCT ON (day) day, equity, cash
        FROM (
          SELECT date_trunc('day', ts + interval '9 hours') AS day, ts, equity, cash
          FROM account.equity_snapshots
          WHERE account_id = ${accountId}
        ) s
        ORDER BY day DESC, ts DESC
      ),
      pnl AS (
        SELECT date_trunc('day', traded_at + interval '9 hours') AS day,
          SUM(realized) AS realized, COUNT(*) AS fills
        FROM account.realized_pnl
        WHERE account_id = ${accountId}
        GROUP BY 1
      )
      SELECT
        COALESCE(eq.day, pnl.day) AS day,
        eq.equity AS close_equity,
        eq.cash AS close_cash,
        COALESCE(pnl.realized, 0) AS realized,
        COALESCE(pnl.fills, 0) AS fills
      FROM eq
      FULL OUTER JOIN pnl ON pnl.day = eq.day
      ORDER BY day DESC
      LIMIT ${take + 1}
    `;
    // 오래된 순으로 전일 종가를 이어 붙인 뒤 최신순으로 돌려준다. LIMIT +1은 첫 표시일의 전일용.
    const ascending = [...rows].reverse();
    const out: DailyPerformance[] = [];
    let previousClose: number | null = null;
    for (const row of ascending) {
      const closeEquity = row.close_equity != null ? Number(row.close_equity) : null;
      const change = closeEquity != null && previousClose != null ? closeEquity - previousClose : null;
      out.push({
        // KST 자정으로 맞춘 시각을 UTC 기준으로 되돌려 YYYY-MM-DD를 만든다.
        date: new Date(row.day.getTime()).toISOString().slice(0, 10),
        closeEquity,
        closeCash: row.close_cash != null ? Number(row.close_cash) : null,
        change,
        changeRate: change != null && previousClose ? change / previousClose : null,
        realized: Number(row.realized),
        fills: Number(row.fills),
      });
      if (closeEquity != null) previousClose = closeEquity;
    }
    return out.slice(-take).reverse();
  }

  async series(accountId: string, range: EquityRange): Promise<EquityPoint[]> {
    const bucket = BUCKET_SECONDS[range];
    const rangeMs = RANGE_MS[range];
    const since = rangeMs == null ? new Date(0) : new Date(Date.now() - rangeMs);
    // 버킷마다 마지막 스냅샷을 대표값으로 쓴다 (종가 방식).
    const rows = await this.prisma.$queryRaw<
      { ts: Date; cash: bigint; stock_value: bigint; equity: bigint }[]
    >`
      SELECT DISTINCT ON (bucket) ts, cash, stock_value, equity
      FROM (
        SELECT
          to_timestamp(floor(extract(epoch FROM ts) / ${bucket}) * ${bucket}) AS bucket,
          ts, cash, stock_value, equity
        FROM account.equity_snapshots
        WHERE account_id = ${accountId} AND ts >= ${since}
      ) s
      ORDER BY bucket ASC, ts DESC
    `;
    return rows.map((row) => ({
      ts: row.ts.getTime(),
      cash: Number(row.cash),
      stockValue: Number(row.stock_value),
      equity: Number(row.equity),
    }));
  }
}
