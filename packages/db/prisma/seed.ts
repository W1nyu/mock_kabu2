import { PrismaClient } from "@prisma/client";
import { SYMBOLS } from "@mock-kabu/shared";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BOT_COUNT = 10;
export const BOT_PASSWORD = "botpassword";
const ADMIN_EMAIL = "admin@admin";
const ADMIN_NICKNAME = "admin";
const ADMIN_PASSWORD = "admin";
const ADMIN_INITIAL_CASH = 10_000_000_000_000_000n;
const BOT_INITIAL_CASH = 1_000_000_000n; // 봇당 10억
const BOT_INITIAL_QTY = 50_000; // 봇당 종목별 5만 주

/** Add only missing inventory when a new listing is introduced after initial seeding. */
async function ensureMissingBotHoldings(accountId: string) {
  for (const s of SYMBOLS) {
    await prisma.holding.upsert({
      where: { accountId_symbol: { accountId, symbol: s.symbol } },
      update: {},
      create: {
        accountId,
        symbol: s.symbol,
        qty: BOT_INITIAL_QTY,
        costBasis: BigInt(BOT_INITIAL_QTY) * BigInt(s.initialPrice),
      },
    });
  }
}

async function ensureAdminAccount() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: {
        passwordHash,
        nickname: ADMIN_NICKNAME,
        isBot: false,
      },
      create: {
        email: ADMIN_EMAIL,
        passwordHash,
        nickname: ADMIN_NICKNAME,
        isBot: false,
      },
    });

    const existingAccount = await tx.account.findUnique({ where: { userId: user.id } });
    if (existingAccount) return false;

    const account = await tx.account.create({
      data: { userId: user.id, balance: ADMIN_INITIAL_CASH },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: account.id,
        delta: ADMIN_INITIAL_CASH,
        balanceAfter: ADMIN_INITIAL_CASH,
        reason: "SEED",
      },
    });
    return true;
  });

  console.log(created ? `admin created: ${ADMIN_EMAIL}` : `admin ensured: ${ADMIN_EMAIL}`);
}

async function main() {
  // 종목
  for (const s of SYMBOLS) {
    await prisma.marketSymbol.upsert({
      where: { symbol: s.symbol },
      update: {},
      create: {
        symbol: s.symbol,
        name: s.name,
        initialPrice: s.initialPrice,
        tickSize: s.tickSize,
        lastPrice: s.initialPrice,
      },
    });
  }
  console.log(`symbols: ${SYMBOLS.length} upserted`);

  await ensureAdminAccount();

  // 봇 유저/계좌/보유자산
  const passwordHash = await bcrypt.hash(BOT_PASSWORD, 10);
  for (let i = 1; i <= BOT_COUNT; i++) {
    const email = `bot${i}@bots.local`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      const account = await prisma.account.findUnique({ where: { userId: existing.id } });
      if (account) await ensureMissingBotHoldings(account.id);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, passwordHash, nickname: `봇#${i}`, isBot: true },
      });
      const account = await tx.account.create({
        data: { userId: user.id, balance: BOT_INITIAL_CASH },
      });
      await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          delta: BOT_INITIAL_CASH,
          balanceAfter: BOT_INITIAL_CASH,
          reason: "SEED",
        },
      });
      for (const s of SYMBOLS) {
        await tx.holding.create({
          data: {
            accountId: account.id,
            symbol: s.symbol,
            qty: BOT_INITIAL_QTY,
            costBasis: BigInt(BOT_INITIAL_QTY) * BigInt(s.initialPrice),
          },
        });
      }
    });
    console.log(`bot created: ${email}`);
  }

  console.log("seed done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
