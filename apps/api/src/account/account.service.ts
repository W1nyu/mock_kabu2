import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import type { PrismaClient } from "@mock-kabu/db";
import { SYMBOLS } from "@mock-kabu/shared";
import { BALANCE_MUTATOR, PRISMA } from "../core/tokens";
import { RealtimeGateway } from "../gateway/realtime.gateway";

@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
    private realtime: RealtimeGateway,
  ) {}

  async getAccount(accountId: string) {
    const acc = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!acc) throw new NotFoundException("계좌를 찾을 수 없습니다");
    return {
      id: acc.id,
      balance: acc.balance,
      holdAmount: acc.holdAmount,
      available: acc.balance - acc.holdAmount,
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

  async getLedger(accountId: string, limit = 50) {
    return this.prisma.ledgerEntry.findMany({
      where: { accountId },
      orderBy: { id: "desc" },
      take: Math.min(limit, 200),
    });
  }

  /** 계좌 이체 — 두 계좌를 ID 오름차순으로 잠근다 (스펙 S1 해결 지점) */
  async transfer(fromAccountId: string, toEmail: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException("이체 금액은 양의 정수여야 합니다");
    }
    const toUser = await this.prisma.user.findUnique({ where: { email: toEmail } });
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
      const available = from.balance - from.holdAmount;
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
