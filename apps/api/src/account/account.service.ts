import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { isTradingFeeExempt, Prisma, type PrismaClient } from "@mock-kabu/db";
import { ADMIN_NICKNAME, futureDef, optionDef, SYMBOLS, tradeNotional, tradingFee } from "@mock-kabu/shared";
import { koreaDayStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { futuresEncumbrance } from "../order/futures-margin";
import { futuresValueSql } from "./futures-equity";
import { PRISMA } from "../core/tokens";

/** 랭킹은 모든 사용자 계정을 LATERAL 조인으로 훑는다 — 보는 사람 수만큼 반복할 이유가 없다. */
const LEADERBOARD_TTL_MS = 10_000;
const LEADERBOARD_STALE_MS = 5 * 60_000;

export type LeaderboardPeriod = "all" | "today" | "week";

interface RealizedTotalsRow {
  today: bigint;
  today_qty: bigint;
  total: bigint;
  total_qty: bigint;
  fills: bigint;
  wins: bigint;
  losses: bigint;
  win_sum: bigint;
  loss_sum: bigint;
  best: bigint | null;
  worst: bigint | null;
}

/** 청산 체결 단위 성과(승률·평균 손익·손익비·최고/최저). 손익 0인 체결은 승/패 어느 쪽에도 넣지 않는다. */
function realizedStats(row: RealizedTotalsRow | undefined) {
  const fills = Number(row?.fills ?? 0n);
  const wins = Number(row?.wins ?? 0n);
  const losses = Number(row?.losses ?? 0n);
  const winSum = Number(row?.win_sum ?? 0n);
  const lossSum = Math.abs(Number(row?.loss_sum ?? 0n));
  return {
    fills,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    avgWin: wins > 0 ? winSum / wins : null,
    avgLoss: losses > 0 ? lossSum / losses : null,
    // 손익비(profit factor) = 총이익 / 총손실. 손실이 없으면 정의하지 않는다.
    profitFactor: lossSum > 0 ? winSum / lossSum : null,
    best: row?.best != null ? Number(row.best) : null,
    worst: row?.worst != null ? Number(row.worst) : null,
  };
}

@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  async getAccount(accountId: string) {
    // 서로 독립인 조회라 한 번에 보낸다(대시보드·봇이 자주 부른다).
    const [acc, futures, tradingFeeExempt] = await Promise.all([
      this.prisma.account.findUnique({ where: { id: accountId } }),
      // 선물 포지션 증거금은 holdAmount와 따로 묶여 있다 — 주문·이체 가능 금액에서 함께 뺀다.
      futuresEncumbrance(this.prisma, accountId),
      isTradingFeeExempt(this.prisma, accountId),
    ]);
    if (!acc) throw new NotFoundException("계좌를 찾을 수 없습니다");
    const available = acc.balance - acc.holdAmount - futures.total;
    return {
      id: acc.id,
      balance: acc.balance,
      balanceExact: acc.balance.toString(),
      holdAmount: acc.holdAmount,
      futuresMargin: futures.margin,
      futuresDebt: futures.debt,
      available,
      availableExact: available.toString(),
      tradingFeeExempt,
    };
  }

  async getHoldings(accountId: string) {
    const [holdings, symbols] = await Promise.all([
      this.prisma.holding.findMany({
        where: { accountId, qty: { gt: 0 }, symbol: { in: SYMBOLS.map((symbol) => symbol.symbol) } },
        orderBy: { symbol: "asc" },
      }),
      this.prisma.marketSymbol.findMany({
        where: { symbol: { in: SYMBOLS.map((symbol) => symbol.symbol) } },
        select: { symbol: true, lastPrice: true },
      }),
    ]);
    const lastPrice = new Map(symbols.map((s) => [s.symbol, s.lastPrice]));
    return holdings.map((h) => {
      const price = lastPrice.get(h.symbol) ?? 0;
      const value = price * h.qty;
      const costBasis = Number(h.costBasis);
      const pnl = value - costBasis;
      return {
        symbol: h.symbol,
        qty: h.qty,
        holdQty: h.holdQty,
        availableQty: h.qty - h.holdQty,
        lastPrice: price,
        value,
        costBasis,
        avgCost: h.qty > 0 ? costBasis / h.qty : 0,
        pnl,
        pnlRate: costBasis > 0 ? pnl / costBasis : 0,
      };
    });
  }

  /**
   * 실현손익 요약. 매도 체결마다 정산이 남긴 realized_pnl을 KST 당일/누적/종목별로 합산한다.
   * 테이블 도입 전의 매도는 행이 없으므로 그 이전 손익은 포함되지 않는다.
   */
  async getRealizedPnl(accountId: string, limit = 50) {
    const dayStart = koreaDayStart();
    const [totals, bySymbol, recent, futuresTotals, combinedTotals] = await Promise.all([
      this.prisma.$queryRaw<RealizedTotalsRow[]>`
        SELECT
          COALESCE(SUM(realized) FILTER (WHERE traded_at >= ${dayStart}), 0) AS today,
          COALESCE(SUM(qty) FILTER (WHERE traded_at >= ${dayStart}), 0) AS today_qty,
          COALESCE(SUM(realized), 0) AS total,
          COALESCE(SUM(qty), 0) AS total_qty,
          COUNT(*) AS fills,
          COUNT(*) FILTER (WHERE realized > 0) AS wins,
          COUNT(*) FILTER (WHERE realized < 0) AS losses,
          COALESCE(SUM(realized) FILTER (WHERE realized > 0), 0) AS win_sum,
          COALESCE(SUM(realized) FILTER (WHERE realized < 0), 0) AS loss_sum,
          MAX(realized) AS best,
          MIN(realized) AS worst
        FROM account.realized_pnl
        WHERE account_id = ${accountId}
      `,
      this.prisma.realizedPnl.groupBy({
        by: ["symbol"],
        where: { accountId },
        _sum: { realized: true, qty: true, costBasis: true },
        orderBy: { symbol: "asc" },
      }),
      this.prisma.realizedPnl.findMany({
        where: { accountId },
        orderBy: { id: "desc" },
        take: Math.min(Math.max(1, limit), 200),
      }),
      // 선물 청산(반대매매·일일 정산 포함) 한 건 = 한 행. 주식 매도 체결과 같은 모양으로 집계한다.
      this.prisma.$queryRaw<RealizedTotalsRow[]>`
        SELECT
          COALESCE(SUM(realized) FILTER (WHERE created_at >= ${dayStart}), 0) AS today,
          COALESCE(SUM(closed_qty) FILTER (WHERE created_at >= ${dayStart}), 0) AS today_qty,
          COALESCE(SUM(realized), 0) AS total,
          COALESCE(SUM(closed_qty), 0) AS total_qty,
          COUNT(*) AS fills,
          COUNT(*) FILTER (WHERE realized > 0) AS wins,
          COUNT(*) FILTER (WHERE realized < 0) AS losses,
          COALESCE(SUM(realized) FILTER (WHERE realized > 0), 0) AS win_sum,
          COALESCE(SUM(realized) FILTER (WHERE realized < 0), 0) AS loss_sum,
          MAX(realized) AS best,
          MIN(realized) AS worst
        FROM account.futures_realized
        WHERE account_id = ${accountId}
      `,
      // 주식 매도 체결 + 선물 청산을 한데 모은 성과(대시보드 매매 성과 "전체" 탭)
      this.prisma.$queryRaw<RealizedTotalsRow[]>`
        SELECT
          COALESCE(SUM(realized) FILTER (WHERE at >= ${dayStart}), 0) AS today,
          COALESCE(SUM(qty) FILTER (WHERE at >= ${dayStart}), 0) AS today_qty,
          COALESCE(SUM(realized), 0) AS total,
          COALESCE(SUM(qty), 0) AS total_qty,
          COUNT(*) AS fills,
          COUNT(*) FILTER (WHERE realized > 0) AS wins,
          COUNT(*) FILTER (WHERE realized < 0) AS losses,
          COALESCE(SUM(realized) FILTER (WHERE realized > 0), 0) AS win_sum,
          COALESCE(SUM(realized) FILTER (WHERE realized < 0), 0) AS loss_sum,
          MAX(realized) AS best,
          MIN(realized) AS worst
        FROM (
          SELECT traded_at AS at, qty, realized FROM account.realized_pnl WHERE account_id = ${accountId}
          UNION ALL
          SELECT created_at AS at, closed_qty AS qty, realized FROM account.futures_realized WHERE account_id = ${accountId}
        ) x
      `,
    ]);
    const row = totals[0];
    const futuresRow = futuresTotals[0];
    return {
      today: Number(row?.today ?? 0n),
      todayQty: Number(row?.today_qty ?? 0n),
      total: Number(row?.total ?? 0n),
      totalQty: Number(row?.total_qty ?? 0n),
      /** 매도 체결 단위 성과. 손익 0인 체결은 승/패 어느 쪽에도 넣지 않는다. */
      stats: realizedStats(row),
      /** 선물 청산 실현손익(원). 주식과 같은 모양 — 대시보드가 주식/선물을 나눠 보여 준다. */
      futures: {
        today: Number(futuresRow?.today ?? 0n),
        todayQty: Number(futuresRow?.today_qty ?? 0n),
        total: Number(futuresRow?.total ?? 0n),
        totalQty: Number(futuresRow?.total_qty ?? 0n),
        stats: realizedStats(futuresRow),
      },
      /** 주식 + 선물 합산 성과 */
      combined: {
        today: Number(combinedTotals[0]?.today ?? 0n),
        total: Number(combinedTotals[0]?.total ?? 0n),
        stats: realizedStats(combinedTotals[0]),
      },
      bySymbol: bySymbol.map((group) => {
        const realized = Number(group._sum.realized ?? 0n);
        const costBasis = Number(group._sum.costBasis ?? 0n);
        return {
          symbol: group.symbol,
          qty: group._sum.qty ?? 0,
          realized,
          costBasis,
          // 차감 원가 대비 수익률. 원가 0(레거시 시드 매도)은 정의하지 않는다.
          realizedRate: costBasis > 0 ? realized / costBasis : null,
        };
      }),
      recent: recent.map((entry) => ({
        id: Number(entry.id),
        symbol: entry.symbol,
        tradeId: entry.tradeId,
        qty: entry.qty,
        price: entry.price,
        costBasis: Number(entry.costBasis),
        realized: Number(entry.realized),
        tradedAt: entry.tradedAt,
      })),
    };
  }

  /** 내 체결 내역. 매수·매도 양쪽 원장을 계정 기준 한 줄로 합쳐 최신순으로 돌려준다. */
  async getTrades(accountId: string, limit = 100, symbol?: string) {
    const take = Math.min(Math.max(1, limit), 200);
    const feeExempt = await isTradingFeeExempt(this.prisma, accountId);
    const [trades, realized, futuresRealized] = await Promise.all([
      this.prisma.trade.findMany({
        where: {
          OR: [{ buyerAccountId: accountId }, { sellerAccountId: accountId }],
          ...(symbol ? { symbol } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
      }),
      this.prisma.realizedPnl.findMany({
        where: { accountId, ...(symbol ? { symbol } : {}) },
        orderBy: { id: "desc" },
        take,
        select: { tradeId: true, realized: true, costBasis: true },
      }),
      // 선물·옵션은 매수·매도 어느 쪽이든 포지션을 줄이면 실현손익이 생긴다(futures_realized, trade_id + side).
      this.prisma.futuresRealized.findMany({
        where: { accountId, ...(symbol ? { symbol } : {}) },
        orderBy: { createdAt: "desc" },
        take,
        select: { tradeId: true, side: true, realized: true },
      }),
    ]);
    const realizedByTrade = new Map(realized.map((row) => [row.tradeId, row]));
    const futuresRealizedByTrade = new Map(futuresRealized.map((row) => [`${row.tradeId}:${row.side}`, row.realized]));
    return trades.map((trade) => {
      const isBuyer = trade.buyerAccountId === accountId;
      const isSeller = trade.sellerAccountId === accountId;
      // 자기 체결은 매칭 엔진이 막지만, 만약 있다면 매수·매도 양쪽 원장이므로 SELF로 표시한다.
      const side = isBuyer && isSeller ? "SELF" : isBuyer ? "BUY" : "SELL";
      const fee = feeExempt ? 0 : Number(tradingFee(tradeNotional(trade.symbol, trade.price, trade.qty), trade.createdAt.getTime())) * (side === "SELF" ? 2 : 1);
      const realizedRow = isSeller ? realizedByTrade.get(trade.id) : undefined;
      // 선물·옵션: 가격은 정수 단위라 체결금액(명목) = 가격 × 수량 × 승수
      const unitValue = futureDef(trade.symbol)?.unitValue ?? optionDef(trade.symbol)?.unitValue ?? null;
      if (unitValue != null) {
        const futureRealized = futuresRealizedByTrade.get(`${trade.id}:${side === "SELF" ? "BUY" : side}`);
        return {
          tradeId: trade.id,
          symbol: trade.symbol,
          side,
          price: trade.price,
          qty: trade.qty,
          amount: trade.price * trade.qty * unitValue,
          fee,
          orderId: isBuyer ? trade.buyOrderId : trade.sellOrderId,
          taker: trade.takerSide === (isBuyer ? "BUY" : "SELL"),
          realized: futureRealized != null ? Number(futureRealized) : null,
          costBasis: null,
          ts: trade.createdAt.getTime(),
        };
      }
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        side,
        price: trade.price,
        qty: trade.qty,
        amount: trade.price * trade.qty,
        fee,
        orderId: isBuyer ? trade.buyOrderId : trade.sellOrderId,
        /** 내가 taker(주문을 넣어 체결시킨 쪽)였는지 */
        taker: trade.takerSide === (isBuyer ? "BUY" : "SELL"),
        realized: realizedRow ? Number(realizedRow.realized) : null,
        costBasis: realizedRow ? Number(realizedRow.costBasis) : null,
        ts: trade.createdAt.getTime(),
      };
    });
  }

  /**
   * 사용자(non-bot) 계정 수익률 랭킹. 수익률 = (총자산 − 순입금) / 순입금.
   * 순입금은 가입 보너스·시드·이체 원장의 합이며, 총자산은 현재 last_price 기준 평가액이다.
   * 봇 계정은 유동성 풀이라 제외한다.
   */
  async getLeaderboard(viewerAccountId: string, limit = 20, period: LeaderboardPeriod = "all") {
    // 순위표 자체는 보는 사람과 무관하니 기간별로 한 번만 계산하고, `me`만 요청마다 붙인다.
    // 만료 뒤 5분까지는 이전 순위를 바로 주고 뒤에서 다시 계산한다 — 랭킹 화면이 무거운 집계를 기다리지 않는다.
    const ranked = await this.cache.getOrCompute(`leaderboard:${period}`, LEADERBOARD_TTL_MS, () => this.rankAccounts(period), {
      staleMs: LEADERBOARD_STALE_MS,
    });
    const withViewer = ranked.map((row) => ({ ...row, me: row.accountId === viewerAccountId }));
    const me = withViewer.find((row) => row.me) ?? null;
    const top = withViewer.slice(0, Math.min(Math.max(1, limit), 100));
    // 상위 밖이어도 내 순위는 항상 함께 돌려준다.
    return { total: withViewer.length, rows: me && !top.some((row) => row.me) ? [...top, me] : top };
  }

  private async rankAccounts(period: LeaderboardPeriod) {
    // 기간 랭킹: 기간 시작 이후 첫 스냅샷을 기준 자산으로, 그 뒤 입출금은 성과에서 뺀다.
    // 기간 시작 전에 스냅샷이 없는(그 뒤 가입한) 계정은 순입금을 기준으로 삼는다.
    const since =
      period === "today" ? koreaDayStart() : period === "week" ? new Date(Date.now() - 7 * 24 * 3_600_000) : new Date(0);
    // 지수 기준 시각: 전체 기간은 가입 시각, 기간 랭킹은 기준 스냅샷 시각(없으면 기간 시작과 가입 중 늦은 쪽).
    const baseTs = period === "all" ? Prisma.sql`u.created_at` : Prisma.sql`COALESCE(b.ts, GREATEST(u.created_at, ${since}))`;
    // 계획 비용이 커서 Postgres가 JIT를 켜는데, 운영에서 JIT 컴파일만 매번 ~1초였다(쿼리 자체는 ~35ms).
    // 이 트랜잭션에서만 끈다(SET LOCAL) — 서버 전역 jit=off는 compose에도 있지만 재시작 전에도 효과가 나게.
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$queryRaw<
      {
        account_id: string;
        nickname: string;
        equity: bigint;
        deposits: bigint;
        realized: bigint;
        joined_at: Date;
        index_ratio: number | null;
        index_current: number | null;
        index_base: number | null;
        base_equity: bigint | null;
        base_ts: Date | null;
        period_flows: bigint;
      }[]
    >`
      SELECT
        a.id AS account_id,
        u.nickname,
        a.balance + COALESCE(v.stock_value, 0) + COALESCE(fv.futures_value, 0) AS equity,
        COALESCE(d.deposits, 0) AS deposits,
        COALESCE(r.realized, 0) AS realized,
        u.created_at AS joined_at,
        b.equity AS base_equity,
        b.ts AS base_ts,
        COALESCE(f.flows, 0) AS period_flows,
        idx.current_level / NULLIF(idx.base_level, 0) AS index_ratio,
        idx.current_level AS index_current,
        idx.base_level AS index_base
      FROM account.accounts a
      -- 봇·관리자·스모크 테스트 계정은 순위에서 뺀다.
      JOIN auth.users u ON u.id = a.user_id AND u.is_bot = false AND u.is_admin = false
        AND u.nickname <> ${ADMIN_NICKNAME} AND u.nickname NOT LIKE 'smoke-%'
      LEFT JOIN LATERAL (
        SELECT equity, ts FROM account.equity_snapshots e
        WHERE e.account_id = a.id AND e.ts >= ${since}
        ORDER BY e.ts ASC LIMIT 1
      ) b ON ${period !== "all"}
      -- /market/index와 같은 시가총액 가중 지수: 그 시각의 구간(index_epochs)의 편입 종목을
      -- Σ(가격 × 발행주식수) ÷ 제수로 합산한다. 기간 랭킹은 기준 자산 스냅샷 시각을 쓴다.
      LEFT JOIN LATERAL (
          SELECT cur.level AS current_level, base.level AS base_level
          FROM (
            SELECT SUM(s.last_price::double precision * s.listed_shares) / MAX(e.divisor) AS level
            FROM (SELECT divisor, members FROM market.index_epochs ORDER BY starts_at DESC LIMIT 1) e
            JOIN market.symbols s ON s.symbol = ANY(e.members)
          ) cur,
          LATERAL (
            SELECT SUM(COALESCE(c.close, s.initial_price)::double precision * s.listed_shares) / MAX(e.divisor) AS level
            FROM (
              SELECT divisor, members FROM market.index_epochs
              WHERE starts_at <= ${baseTs}
              ORDER BY starts_at DESC LIMIT 1
            ) e
            JOIN market.symbols s ON s.symbol = ANY(e.members)
            -- 간격별로 (symbol, interval, ts) 기본키를 역순 1건씩 읽고 늦은 쪽을 쓴다. IN ('1m', '1h') 한 번에
            -- 찾으면 인덱스 순서를 못 써 조회마다 봉 수천 개를 읽고 정렬했다(운영: 계정×종목 1,140회, 1.5~3초).
            LEFT JOIN LATERAL (
              SELECT x.close FROM (
                (SELECT c.close, c.ts FROM market.candles c
                 WHERE c.symbol = s.symbol AND c.interval = '1m' AND c.ts <= ${baseTs}
                 ORDER BY c.ts DESC LIMIT 1)
                UNION ALL
                (SELECT c.close, c.ts FROM market.candles c
                 WHERE c.symbol = s.symbol AND c.interval = '1h' AND c.ts <= ${baseTs}
                 ORDER BY c.ts DESC LIMIT 1)
              ) x
              ORDER BY x.ts DESC LIMIT 1
            ) c ON true
          ) base
      ) idx ON true
      LEFT JOIN LATERAL (
        SELECT SUM(delta) AS flows FROM account.ledger_entries l
        WHERE l.account_id = a.id
          AND l.reason IN ('SIGNUP_BONUS', 'SEED', 'TRANSFER_IN', 'TRANSFER_OUT')
          AND l.created_at > COALESCE(b.ts, ${since})
      ) f ON ${period !== "all"}
      -- 아래 합계는 모두 순위 대상 계정별로(LATERAL + 계정 인덱스) 구한다. 예전에는 봇까지 포함한 원장(180만+ 행)과
      -- 실현손익(90만+ 행)을 통째로 합산한 뒤 조인해, 봇 매매가 쌓일수록 랭킹이 수 초씩 느려졌다.
      LEFT JOIN LATERAL (
        SELECT SUM(h.qty::bigint * s.last_price) AS stock_value
        FROM account.holdings h
        JOIN market.symbols s ON s.symbol = h.symbol
        WHERE h.account_id = a.id
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT SUM(delta) AS deposits
        FROM account.ledger_entries
        WHERE account_id = a.id AND reason IN ('SIGNUP_BONUS', 'SEED', 'TRANSFER_IN', 'TRANSFER_OUT')
      ) d ON true
      -- 실현손익 = 주식 매도 체결 + 선물 청산(반대매매·일일 정산 포함)
      LEFT JOIN LATERAL (
        SELECT
          COALESCE((SELECT SUM(realized) FROM account.realized_pnl WHERE account_id = a.id AND traded_at >= ${since}), 0)
          + COALESCE((SELECT SUM(realized) FROM account.futures_realized WHERE account_id = a.id AND created_at >= ${since}), 0)
          AS realized
      ) r ON true
      -- 선물 평가손익 − 미수금 (총 자산에 포함)
      LEFT JOIN (${futuresValueSql()}) fv ON fv.account_id = a.id
    `,
    ]);
    const ranked = rows
      .map((row) => {
        const equity = Number(row.equity);
        const deposits = Number(row.deposits);
        // 전체 기간: 순입금 대비. 기간 랭킹: 기간 시작 스냅샷(없으면 순입금) 대비, 기간 중 입출금은 제외.
        const base = period === "all" ? deposits : row.base_equity != null ? Number(row.base_equity) : deposits;
        const flows = period === "all" ? 0 : Number(row.period_flows);
        const pnl = equity - base - flows;
        const returnRate = base > 0 ? pnl / base : null;
        const indexRate = row.index_ratio != null && Number.isFinite(row.index_ratio) ? row.index_ratio - 1 : null;
        return {
          accountId: row.account_id,
          nickname: row.nickname,
          equity,
          deposits,
          pnl,
          // 순입금이 0 이하(이체로 전부 내보낸 계정)는 수익률을 정의하지 않고 맨 뒤로 보낸다.
          returnRate,
          /** 가입 이후 시장 지수 등락률과 그 대비 초과수익(알파) */
          indexRate,
          indexCurrent: row.index_current,
          indexBase: row.index_base,
          alpha: returnRate != null && indexRate != null ? returnRate - indexRate : null,
          realized: Number(row.realized),
          joinedAt: row.joined_at.toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.returnRate == null && b.returnRate == null) return b.equity - a.equity;
        if (a.returnRate == null) return 1;
        if (b.returnRate == null) return -1;
        return b.returnRate - a.returnRate || b.equity - a.equity;
      })
      .map((row, index) => ({ rank: index + 1, ...row }));
    return ranked;
  }

  async getLedger(accountId: string, limit = 50) {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { accountId },
      orderBy: { id: "desc" },
      take: Math.min(limit, 200),
    });
    return rows.map((row) => ({ ...row, deltaExact: row.delta.toString(), balanceAfterExact: row.balanceAfter.toString() }));
  }
}
