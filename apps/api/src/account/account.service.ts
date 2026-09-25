import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
  UnauthorizedException,
} from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import { Prisma, type PrismaClient } from "@mock-kabu/db";
import { ADMIN_NICKNAME, SYMBOLS } from "@mock-kabu/shared";
import * as bcrypt from "bcryptjs";
import { koreaDayStart } from "../common/market-time";
import { MemoCache } from "../core/memo-cache";
import { futuresEncumbrance, futuresMarginHeld } from "../order/futures-margin";
import { BALANCE_MUTATOR, PRISMA } from "../core/tokens";

/** 랭킹은 모든 사용자 계정을 LATERAL 조인으로 훑는다 — 보는 사람 수만큼 반복할 이유가 없다. */
const LEADERBOARD_TTL_MS = 10_000;
import { RealtimeGateway } from "../gateway/realtime.gateway";

export type LeaderboardPeriod = "all" | "today" | "week";

@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    private realtime: RealtimeGateway,
    @Optional() private cache: MemoCache = new MemoCache(),
  ) {}

  async getAccount(accountId: string) {
    const acc = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!acc) throw new NotFoundException("계좌를 찾을 수 없습니다");
    // 선물 포지션 증거금은 holdAmount와 따로 묶여 있다 — 주문·이체 가능 금액에서 함께 뺀다.
    const futures = await futuresEncumbrance(this.prisma, accountId);
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
    };
  }

  async getHoldings(accountId: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { accountId, qty: { gt: 0 }, symbol: { in: SYMBOLS.map((symbol) => symbol.symbol) } },
      orderBy: { symbol: "asc" },
    });
    const symbols = await this.prisma.marketSymbol.findMany();
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
    const [totals, bySymbol, recent] = await Promise.all([
      this.prisma.$queryRaw<
        {
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
        }[]
      >`
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
    ]);
    const row = totals[0];
    const fills = Number(row?.fills ?? 0n);
    const wins = Number(row?.wins ?? 0n);
    const losses = Number(row?.losses ?? 0n);
    const winSum = Number(row?.win_sum ?? 0n);
    const lossSum = Math.abs(Number(row?.loss_sum ?? 0n));
    return {
      today: Number(row?.today ?? 0n),
      todayQty: Number(row?.today_qty ?? 0n),
      total: Number(row?.total ?? 0n),
      totalQty: Number(row?.total_qty ?? 0n),
      /** 매도 체결 단위 성과. 손익 0인 체결은 승/패 어느 쪽에도 넣지 않는다. */
      stats: {
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
    const [trades, realized] = await Promise.all([
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
    ]);
    const realizedByTrade = new Map(realized.map((row) => [row.tradeId, row]));
    return trades.map((trade) => {
      const isBuyer = trade.buyerAccountId === accountId;
      const isSeller = trade.sellerAccountId === accountId;
      // 자기 체결은 매칭 엔진이 막지만, 만약 있다면 매수·매도 양쪽 원장이므로 SELF로 표시한다.
      const side = isBuyer && isSeller ? "SELF" : isBuyer ? "BUY" : "SELL";
      const realizedRow = isSeller ? realizedByTrade.get(trade.id) : undefined;
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        side,
        price: trade.price,
        qty: trade.qty,
        amount: trade.price * trade.qty,
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
    const ranked = await this.cache.getOrCompute(`leaderboard:${period}`, LEADERBOARD_TTL_MS, () =>
      this.rankAccounts(period),
    );
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
    const rows = await this.prisma.$queryRaw<
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
        a.balance + COALESCE(v.stock_value, 0) AS equity,
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
              WHERE starts_at <= ${period === "all" ? Prisma.sql`u.created_at` : Prisma.sql`COALESCE(b.ts, GREATEST(u.created_at, ${since}))`}
              ORDER BY starts_at DESC LIMIT 1
            ) e
            JOIN market.symbols s ON s.symbol = ANY(e.members)
            LEFT JOIN LATERAL (
              SELECT close FROM market.candles c
              WHERE c.symbol = s.symbol AND c.interval IN ('1m', '1h')
                AND c.ts <= ${period === "all" ? Prisma.sql`u.created_at` : Prisma.sql`COALESCE(b.ts, GREATEST(u.created_at, ${since}))`}
              ORDER BY c.ts DESC LIMIT 1
            ) c ON true
          ) base
      ) idx ON true
      LEFT JOIN LATERAL (
        SELECT SUM(delta) AS flows FROM account.ledger_entries l
        WHERE l.account_id = a.id
          AND l.reason IN ('SIGNUP_BONUS', 'SEED', 'TRANSFER_IN', 'TRANSFER_OUT')
          AND l.created_at > COALESCE(b.ts, ${since})
      ) f ON ${period !== "all"}
      LEFT JOIN (
        SELECT h.account_id, SUM(h.qty::bigint * s.last_price) AS stock_value
        FROM account.holdings h
        JOIN market.symbols s ON s.symbol = h.symbol
        GROUP BY h.account_id
      ) v ON v.account_id = a.id
      LEFT JOIN (
        SELECT account_id, SUM(delta) AS deposits
        FROM account.ledger_entries
        WHERE reason IN ('SIGNUP_BONUS', 'SEED', 'TRANSFER_IN', 'TRANSFER_OUT')
        GROUP BY account_id
      ) d ON d.account_id = a.id
      LEFT JOIN (
        SELECT account_id, SUM(realized) AS realized
        FROM account.realized_pnl
        WHERE traded_at >= ${since}
        GROUP BY account_id
      ) r ON r.account_id = a.id
    `;
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

  /** Only the seeded admin may browse recipients; searching covers the entire investor table. */
  async adminRecipients(userId: string, query = "") {
    const caller = await this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!caller?.isAdmin) throw new ForbiddenException("관리자만 조회할 수 있습니다");
    const q = typeof query === "string" ? query.trim().slice(0, 50) : "";
    const eligible = { isBot: false, isAdmin: false, NOT: { nickname: { startsWith: "smoke-" } } } as const;
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where: eligible }),
      this.prisma.user.findMany({
        where: { ...eligible, nickname: { contains: q, mode: "insensitive" } },
        select: { id: true, nickname: true },
        orderBy: { nickname: "asc" },
        take: 50,
      }),
    ]);
    return { total, rows };
  }

  /** Atomic equal-amount distribution to every non-bot investor at commit time. */
  async transferAll(fromAccountId: string, userId: string, amountEach: number, adminPassword: string, requestId: string) {
    if (!Number.isSafeInteger(amountEach) || amountEach <= 0) {
      throw new BadRequestException("1인당 이체 금액은 안전한 양의 정수여야 합니다");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId ?? "")) {
      throw new BadRequestException("유효한 이체 요청 ID가 필요합니다");
    }
    if (this.mutator.strategy !== "pessimistic") {
      throw new UnprocessableEntityException("일괄 이체에는 비관적 계좌 잠금이 필요합니다");
    }
    const caller = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!caller?.isAdmin) throw new ForbiddenException("관리자만 이체할 수 있습니다");
    if (!(await bcrypt.compare(adminPassword ?? "", caller.passwordHash))) {
      throw new ForbiddenException("관리자 비밀번호가 올바르지 않습니다");
    }

    const each = BigInt(amountEach);
    const result = await this.prisma.$transaction(async (tx) => {
      // A committed request ID can be replayed safely after a network timeout.
      const inserted = await tx.$executeRaw`
        INSERT INTO account.admin_distributions (request_id, account_id, amount_each)
        VALUES (${requestId}::uuid, ${fromAccountId}, ${each})
        ON CONFLICT (request_id) DO NOTHING
      `;
      if (inserted === 0) {
        const previous = await tx.adminDistribution.findUnique({ where: { requestId } });
        if (!previous || previous.accountId !== fromAccountId || previous.amountEach !== each) {
          throw new BadRequestException("이미 다른 이체에 사용한 요청 ID입니다");
        }
        return { ok: true, requestId, recipients: previous.recipientCount, total: previous.total.toString(), replay: true, recipientIds: [] as string[] };
      }

      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3000ms'");
      const rows = await tx.$queryRaw<{ id: string; balance: bigint; hold_amount: bigint }[]>`
        SELECT a.id, a.balance, a.hold_amount
        FROM account.accounts a JOIN auth.users u ON u.id = a.user_id
        WHERE a.id = ${fromAccountId} OR (u.is_bot = false AND u.is_admin = false AND u.nickname NOT LIKE 'smoke-%')
        ORDER BY a.id FOR UPDATE OF a
      `;
      const sender = rows.find((row) => row.id === fromAccountId);
      if (!sender) throw new NotFoundException("관리자 계좌가 없습니다");
      const recipientIds = rows.filter((row) => row.id !== fromAccountId).map((row) => row.id);
      if (recipientIds.length === 0) throw new UnprocessableEntityException("이체할 투자자가 없습니다");
      const total = each * BigInt(recipientIds.length);
      if (sender.balance - sender.hold_amount < total) throw new UnprocessableEntityException("잔액이 부족합니다");

      await tx.account.update({ where: { id: fromAccountId }, data: { balance: { decrement: total }, version: { increment: 1 } } });
      await tx.ledgerEntry.create({ data: {
        accountId: fromAccountId, delta: -total, balanceAfter: sender.balance - total,
        reason: "TRANSFER_OUT", refId: requestId,
      } });
      await tx.$executeRaw`
        UPDATE account.accounts SET balance = balance + ${each}, version = version + 1
        WHERE id IN (${Prisma.join(recipientIds)})
      `;
      await tx.$executeRaw`
        INSERT INTO account.ledger_entries (account_id, delta, balance_after, reason, ref_id)
        SELECT id, ${each}, balance, 'TRANSFER_IN', ${requestId}
        FROM account.accounts WHERE id IN (${Prisma.join(recipientIds)})
      `;
      await tx.adminDistribution.update({ where: { requestId }, data: { recipientCount: recipientIds.length, total } });
      return { ok: true, requestId, recipients: recipientIds.length, total: total.toString(), replay: false, recipientIds };
    }, { timeout: 30_000 });

    if (!result.replay) {
      this.realtime.notifyAccount(fromAccountId, { type: "balance" });
      for (const accountId of result.recipientIds) this.realtime.notifyAccount(accountId, { type: "balance" });
    }
    const { recipientIds: _recipientIds, ...publicResult } = result;
    return publicResult;
  }

  /** 계좌 이체 — 두 계좌를 ID 오름차순으로 잠근다 (스펙 S1 해결 지점) */
  async transfer(fromAccountId: string, toNickname: string, amount: number, userId?: string, adminPassword?: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException("이체 금액은 양의 정수여야 합니다");
    }
    if (userId) {
      const caller = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!caller) throw new UnauthorizedException("사용자를 찾을 수 없습니다");
      if (caller.isAdmin && !(await bcrypt.compare(adminPassword ?? "", caller.passwordHash))) {
        throw new ForbiddenException("관리자 비밀번호가 올바르지 않습니다");
      }
    }
    const nickname = (toNickname ?? "").trim();
    if (!nickname) throw new BadRequestException("받는 사람 닉네임을 입력하세요");
    const toUser = await this.prisma.user.findUnique({ where: { nickname } });
    if (!toUser) throw new NotFoundException("받는 사람을 찾을 수 없습니다");
    const toAccount = await this.prisma.account.findUnique({ where: { userId: toUser.id } });
    if (!toAccount) throw new NotFoundException("받는 사람의 계좌가 없습니다");
    if (toAccount.id === fromAccountId) {
      throw new BadRequestException("자기 자신에게는 이체할 수 없습니다");
    }

    const delta = BigInt(amount);

    await this.mutator.withAccountLock([fromAccountId, toAccount.id], async (ctx) => {
      const from = ctx.accounts[fromAccountId];
      const to = ctx.accounts[toAccount.id];
      const available = from.balance - from.holdAmount - (await futuresMarginHeld(ctx.tx, fromAccountId));
      if (available < delta) {
        throw new UnprocessableEntityException("잔액이 부족합니다");
      }

      await ctx.updateAccount(fromAccountId, {
        balance: from.balance - delta,
        holdAmount: from.holdAmount,
      });
      await ctx.updateAccount(toAccount.id, {
        balance: to.balance + delta,
        holdAmount: to.holdAmount,
      });
      await ctx.tx.ledgerEntry.create({
        data: {
          accountId: fromAccountId,
          delta: -delta,
          balanceAfter: from.balance - delta,
          reason: "TRANSFER_OUT",
          refId: toAccount.id,
        },
      });
      await ctx.tx.ledgerEntry.create({
        data: {
          accountId: toAccount.id,
          delta,
          balanceAfter: to.balance + delta,
          reason: "TRANSFER_IN",
          refId: fromAccountId,
        },
      });
    });

    this.realtime.notifyAccount(fromAccountId, { type: "balance" });
    this.realtime.notifyAccount(toAccount.id, { type: "balance" });
    return { ok: true };
  }
}
