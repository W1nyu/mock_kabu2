import { PrismaClient } from "@prisma/client";
import { ADMIN_NICKNAME, INDEX_BASE_LEVEL, SYMBOLS, FUTURES } from "@mock-kabu/shared";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BOT_COUNT = 10;
function requiredSeedSecret(name: string, developmentDefault: string): string {
  const value = process.env[name]?.trim();
  if (value && (process.env.NODE_ENV !== "production" || value !== developmentDefault)) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set to a non-default value when NODE_ENV=production`);
  }
  return developmentDefault;
}

export const BOT_PASSWORD = requiredSeedSecret("BOT_PASSWORD", "botpassword");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() || "admin@admin";
// Never ship a usable default for the privileged account. The deployment keeps
// this value in its mode-600 env file; only the bcrypt hash enters the database.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD must be supplied with at least 12 characters");
}
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
        isAdmin: true,
      },
      create: {
        email: ADMIN_EMAIL,
        passwordHash,
        nickname: ADMIN_NICKNAME,
        isBot: false,
        isAdmin: true,
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
      update: { listedShares: BigInt(s.listedShares) },
      create: {
        symbol: s.symbol,
        name: s.name,
        initialPrice: s.initialPrice,
        tickSize: s.tickSize,
        lastPrice: s.initialPrice,
        listedShares: BigInt(s.listedShares),
      },
    });
  }
  console.log(`symbols: ${SYMBOLS.length} upserted`);

  // 선물 — 같은 표에 kind=FUTURE로 둔다(매칭엔진·체결·봉 재사용). 가격은 정수 단위(실제 × priceScale).
  for (const f of FUTURES) {
    await prisma.marketSymbol.upsert({
      where: { symbol: f.symbol },
      update: { kind: "FUTURE" },
      create: {
        symbol: f.symbol,
        name: f.name,
        initialPrice: f.initialPrice,
        tickSize: f.tickUnits,
        lastPrice: f.initialPrice,
        listedShares: 0n,
        kind: "FUTURE",
      },
    });
  }
  console.log(`futures: ${FUTURES.length} upserted`);

  // 지수 첫 구간 — 새 DB에서는 마이그레이션 시점에 종목이 없어 여기서 만든다.
  if ((await prisma.indexEpoch.count()) === 0) {
    const cap = SYMBOLS.reduce((sum, s) => sum + s.initialPrice * s.listedShares, 0);
    await prisma.indexEpoch.create({
      data: {
        startsAt: new Date(0),
        divisor: cap / INDEX_BASE_LEVEL,
        members: SYMBOLS.map((s) => s.symbol).sort(),
      },
    });
    console.log("index epoch: initial market-cap epoch created");
  }

  await ensureAdminAccount();

  // 봇 유저/계좌/보유자산
  const passwordHash = await bcrypt.hash(BOT_PASSWORD, 10);
  for (let i = 1; i <= BOT_COUNT; i++) {
    const email = `bot${i}@bots.local`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Re-running seed after a credential rotation must leave the worker
      // accounts usable; this only affects the reserved bot identities.
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, isBot: true },
      });
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
