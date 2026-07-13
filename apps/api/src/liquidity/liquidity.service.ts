import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import type { PrismaClient } from "@mock-kabu/db";
import * as bcrypt from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import { BALANCE_MUTATOR, PRISMA } from "../core/tokens";
import {
  LIQUIDITY_BOT_PASSWORD,
  LIQUIDITY_MIN_AVAILABLE_CASH,
  liquidityMinimumAvailableQty,
  liquidityBootstrapToken,
  liquidityReserves,
  type LiquidityReserve,
} from "./liquidity-reserve";

const RETRYABLE_PRISMA_CODES = new Set(["P2002", "P2034"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ReserveIdentity {
  accountId: string;
  created: boolean;
}

/**
 * Local-only reserve provisioning for the market-maker process.
 *
 * It never reads or writes user accounts, and never touches bot1..bot10.  A
 * reserve is only topped up to a defined available floor; no order is
 * cancelled, edited, or otherwise repaired here.
 */
@Injectable()
export class LiquidityService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(BALANCE_MUTATOR) private mutator: BalanceMutator,
  ) {}

  async ensureReserves(presentedToken: string | undefined) {
    this.assertToken(presentedToken);
    const reserves = [] as {
      symbol: string;
      email: string;
      created: boolean;
      cashAdded: bigint;
      qtyAdded: number;
    }[];

    // Sequentially provisioning the five fixed accounts keeps first startup
    // easy to reason about. Account-level locking still makes concurrent API
    // and bots processes safe.
    for (const reserve of liquidityReserves()) {
      reserves.push(await this.ensureReserve(reserve));
    }
    return { reserves };
  }

  private assertToken(presentedToken: string | undefined) {
    const expected = Buffer.from(liquidityBootstrapToken());
    const presented = Buffer.from(presentedToken ?? "");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new UnauthorizedException("invalid liquidity bootstrap token");
    }
  }

  private async ensureReserve(reserve: LiquidityReserve) {
    const identity = await this.ensureIdentityWithRetry(reserve);
    const result = await this.mutator.withAccountLock([identity.accountId], async (ctx) => {
      const account = ctx.accounts[identity.accountId];
      const availableCash = account.balance - account.holdAmount;
      const cashAdded =
        availableCash < LIQUIDITY_MIN_AVAILABLE_CASH
          ? LIQUIDITY_MIN_AVAILABLE_CASH - availableCash
          : 0n;

      if (cashAdded > 0n) {
        const balanceAfter = account.balance + cashAdded;
        await ctx.updateAccount(identity.accountId, {
          balance: balanceAfter,
          holdAmount: account.holdAmount,
        });
        await ctx.tx.ledgerEntry.create({
          data: {
            accountId: identity.accountId,
            delta: cashAdded,
            balanceAfter,
            reason: identity.created ? "LIQUIDITY_BOOTSTRAP" : "LIQUIDITY_REBALANCE",
          },
        });
      }

      const symbol = await ctx.tx.marketSymbol.findUnique({ where: { symbol: reserve.symbol.symbol } });
      if (!symbol) throw new Error(`liquidity reserve symbol is missing: ${reserve.symbol.symbol}`);

      const holding = await ctx.tx.holding.findUnique({
        where: { accountId_symbol: { accountId: identity.accountId, symbol: reserve.symbol.symbol } },
      });
      const availableQty = holding ? holding.qty - holding.holdQty : 0;
      const qtyFloor = liquidityMinimumAvailableQty(symbol.lastPrice);
      const qtyAdded = Math.max(0, qtyFloor - availableQty);
      if (qtyAdded > 0) {
        const costAdded = BigInt(Math.max(1, symbol.lastPrice)) * BigInt(qtyAdded);
        await ctx.tx.holding.upsert({
          where: { accountId_symbol: { accountId: identity.accountId, symbol: reserve.symbol.symbol } },
          update: {
            qty: { increment: qtyAdded },
            costBasis: { increment: costAdded },
          },
          create: {
            accountId: identity.accountId,
            symbol: reserve.symbol.symbol,
            qty: qtyAdded,
            costBasis: costAdded,
          },
        });
      }

      return { cashAdded, qtyAdded };
    });

    return {
      symbol: reserve.symbol.symbol,
      email: reserve.email,
      created: identity.created,
      ...result,
    };
  }

  /**
   * Account creation is the only point where a first concurrent startup can
   * collide. Retrying unique/serializable conflicts is safe because every
   * subsequent step raises an available floor rather than adding a fixed sum.
   */
  private async ensureIdentityWithRetry(reserve: LiquidityReserve): Promise<ReserveIdentity> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await this.ensureIdentity(reserve);
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (!code || !RETRYABLE_PRISMA_CODES.has(code) || attempt === 4) throw error;
        await sleep(20 * attempt);
      }
    }
    throw new Error("unreachable liquidity identity retry");
  }

  private async ensureIdentity(reserve: LiquidityReserve): Promise<ReserveIdentity> {
    let user = await this.prisma.user.findUnique({ where: { email: reserve.email } });
    if (user && !user.isBot) {
      // A human account must never be adopted just because it happens to have
      // a reserved-looking email address.
      throw new ConflictException(`liquidity reserve email belongs to a non-bot user: ${reserve.email}`);
    }
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: reserve.email,
          passwordHash: await bcrypt.hash(LIQUIDITY_BOT_PASSWORD, 10),
          nickname: reserve.nickname,
          isBot: true,
        },
      });
    }

    const existingAccount = await this.prisma.account.findUnique({ where: { userId: user.id } });
    if (existingAccount) return { accountId: existingAccount.id, created: false };

    const account = await this.prisma.account.create({ data: { userId: user.id } });
    return { accountId: account.id, created: true };
  }
}
