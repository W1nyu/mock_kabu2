import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  buildRecoveryPlan,
  type RecoveryInput,
  type RecoveryPlan,
  type RecoveryTrade,
} from "./settlement-recovery-plan";

const APPLY_CONFIRMATION = "RECOVER_UNSETTLED_TRADES";
const RECOVERY_ADVISORY_LOCK = "mock-kabu2:settlement-recovery";

type Tx = any;

interface Preflight {
  input: RecoveryInput;
  plan: RecoveryPlan;
  fingerprint: string;
}

class UnsafePlanError extends Error {}
class SnapshotChangedError extends Error {}

function usage() {
  console.log(`
미정산 체결 복구 (기본: 읽기 전용 dry-run)

  pnpm recover:settlement
  pnpm recover:settlement --apply --confirm=${APPLY_CONFIRMATION}

--apply 전에는 api / matching-engine / bots를 중지하세요. 적용 직전에
동일 스냅샷을 다시 읽어 dry-run과 달라지면 아무 것도 쓰지 않고 중단합니다.
`);
}

function addQty(map: Map<string, number>, id: string, qty: number) {
  map.set(id, (map.get(id) ?? 0) + qty);
}

async function loadRecoveryInput(db: Tx): Promise<RecoveryInput> {
  const [trades, orders, accounts, holdings, symbols] = await Promise.all([
    db.trade.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.order.findMany({ orderBy: { id: "asc" } }),
    db.account.findMany({ orderBy: { id: "asc" } }),
    db.holding.findMany({ orderBy: [{ accountId: "asc" }, { symbol: "asc" }] }),
    db.marketSymbol.findMany({ select: { symbol: true }, orderBy: { symbol: "asc" } }),
  ]);
  const processed = trades.length
    ? await db.processedEvent.findMany({
        where: { eventId: { in: trades.map((trade: { id: string }) => trade.id) } },
        select: { eventId: true },
      })
    : [];
  const processedIds = new Set(processed.map((event: { eventId: string }) => event.eventId));
  const recordedFillQtyByOrder = new Map<string, number>();
  const unsettledFillQtyByOrder = new Map<string, number>();
  const unsettledTrades: RecoveryTrade[] = [];

  for (const trade of trades) {
    addQty(recordedFillQtyByOrder, trade.buyOrderId, trade.qty);
    addQty(recordedFillQtyByOrder, trade.sellOrderId, trade.qty);
    if (processedIds.has(trade.id)) continue;
    unsettledTrades.push({
      id: trade.id,
      symbol: trade.symbol,
      price: trade.price,
      qty: trade.qty,
      buyOrderId: trade.buyOrderId,
      sellOrderId: trade.sellOrderId,
      buyerAccountId: trade.buyerAccountId,
      sellerAccountId: trade.sellerAccountId,
      createdAt: trade.createdAt,
    });
    addQty(unsettledFillQtyByOrder, trade.buyOrderId, trade.qty);
    addQty(unsettledFillQtyByOrder, trade.sellOrderId, trade.qty);
  }

  return {
    unsettledTrades,
    orders: orders.map((order: any) => ({
      id: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      filledQty: order.filledQty,
      status: order.status,
      holdPerUnit: order.holdPerUnit,
    })),
    accounts: accounts.map((account: any) => ({
      id: account.id,
      balance: account.balance,
      holdAmount: account.holdAmount,
    })),
    holdings: holdings.map((holding: any) => ({
      accountId: holding.accountId,
      symbol: holding.symbol,
      qty: holding.qty,
      holdQty: holding.holdQty,
      costBasis: holding.costBasis,
    })),
    recordedFillQtyByOrder,
    unsettledFillQtyByOrder,
    knownSymbols: new Set(symbols.map((symbol: { symbol: string }) => symbol.symbol)),
  };
}

function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function fingerprint(input: RecoveryInput, plan: RecoveryPlan): string {
  const body = {
    unsettledTrades: input.unsettledTrades.map((trade) => [
      trade.id,
      trade.symbol,
      trade.price,
      trade.qty,
      trade.buyOrderId,
      trade.sellOrderId,
      trade.buyerAccountId,
      trade.sellerAccountId,
      trade.createdAt.toISOString(),
    ]),
    orders: input.orders.map((order) => [
      order.id,
      order.accountId,
      order.symbol,
      order.side,
      order.qty,
      order.filledQty,
      order.status,
      order.holdPerUnit,
    ]),
    accounts: input.accounts.map((account) => [account.id, account.balance, account.holdAmount]),
    holdings: input.holdings.map((holding) => [
      holding.accountId,
      holding.symbol,
      holding.qty,
      holding.holdQty,
      holding.costBasis,
    ]),
    recorded: [...input.recordedFillQtyByOrder.entries()].sort(),
    unsettled: [...input.unsettledFillQtyByOrder.entries()].sort(),
    plan: {
      issues: plan.issues,
      preCash: plan.preReplayAccountReservations,
      preQty: plan.preReplayHoldingReservations,
      events: plan.processedEventIds,
      accounts: plan.accounts,
      holdings: plan.holdings,
      orders: plan.orders,
    },
  };
  return createHash("sha256").update(json(body)).digest("hex");
}

async function preflight(db: Tx): Promise<Preflight> {
  const input = await loadRecoveryInput(db);
  const plan = buildRecoveryPlan(input);
  return { input, plan, fingerprint: fingerprint(input, plan) };
}

function report(run: Preflight, mode: "dry-run" | "apply") {
  const { input, plan } = run;
  console.log(`[recovery] mode=${mode}`);
  console.log(`[recovery] unsettled matching trades: ${input.unsettledTrades.length}`);
  console.log(
    `[recovery] planned: events=${plan.processedEventIds.length}, ledger=${plan.ledgerEntries.length}, ` +
      `account-reservations=${plan.preReplayAccountReservations.length}, holding-reservations=${plan.preReplayHoldingReservations.length}`,
  );
  if (plan.issues.length) {
    console.error(`[recovery] BLOCKED: ${plan.issues.length} safety issue(s)`);
    for (const issue of plan.issues.slice(0, 40)) {
      console.error(`  - ${issue.code}${issue.tradeId ? ` trade=${issue.tradeId}` : ""}: ${issue.message}`);
    }
    if (plan.issues.length > 40) console.error(`  ... ${plan.issues.length - 40} more`);
  } else {
    console.log(`[recovery] SAFE fingerprint=${run.fingerprint}`);
  }
}

async function lockAllAccounts(tx: Tx) {
  await tx.$queryRawUnsafe(
    'SELECT id FROM "account"."accounts" ORDER BY id FOR UPDATE',
  );
}

async function repairCandle(tx: Tx, symbol: string, bucket: Date) {
  const end = new Date(bucket.getTime() + 60_000);
  await tx.$executeRawUnsafe(
    `INSERT INTO "market"."candles" ("symbol", "interval", "ts", "open", "high", "low", "close", "volume")
     SELECT $1::text, '1m', $2::timestamp,
       (array_agg(t.price ORDER BY t.created_at ASC, t.id ASC))[1],
       MAX(t.price), MIN(t.price),
       (array_agg(t.price ORDER BY t.created_at DESC, t.id DESC))[1],
       SUM(t.qty)::bigint
     FROM "matching"."trades" t
     WHERE t.symbol = $1 AND t.created_at >= $2 AND t.created_at < $3
     GROUP BY t.symbol
     ON CONFLICT ("symbol", "interval", "ts") DO UPDATE SET
       "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low",
       "close" = EXCLUDED."close", "volume" = EXCLUDED."volume"`,
    symbol,
    bucket,
    end,
  );
}

async function applyPlan(tx: Tx, plan: RecoveryPlan) {
  // Stage 1: restore exactly the reservation needed immediately before replay.
  for (const adjustment of plan.preReplayAccountReservations) {
    await tx.account.update({
      where: { id: adjustment.accountId },
      data: { holdAmount: adjustment.toHoldAmount, version: { increment: 1 } },
    });
  }
  for (const adjustment of plan.preReplayHoldingReservations) {
    await tx.holding.update({
      where: { accountId_symbol: { accountId: adjustment.accountId, symbol: adjustment.symbol } },
      data: { holdQty: adjustment.toHoldQty },
    });
  }

  // Stage 2: exact once-only settlement effects, keyed by matching.trade.id.
  for (const eventId of plan.processedEventIds) {
    await tx.processedEvent.create({ data: { eventId } });
  }
  for (const entry of plan.ledgerEntries) {
    await tx.ledgerEntry.create({ data: entry });
  }
  for (const account of plan.accounts) {
    await tx.account.update({
      where: { id: account.id },
      data: {
        balance: account.balance,
        holdAmount: account.holdAmount,
        version: { increment: account.versionIncrement },
      },
    });
  }
  for (const holding of plan.holdings) {
    if (holding.existed) {
      await tx.holding.update({
        where: { accountId_symbol: { accountId: holding.accountId, symbol: holding.symbol } },
        data: { qty: holding.qty, holdQty: holding.holdQty, costBasis: holding.costBasis },
      });
    } else {
      await tx.holding.create({
        data: {
          accountId: holding.accountId,
          symbol: holding.symbol,
          qty: holding.qty,
          holdQty: holding.holdQty,
          costBasis: holding.costBasis,
        },
      });
    }
  }
  for (const order of plan.orders) {
    await tx.order.update({ where: { id: order.id }, data: { filledQty: order.filledQty, status: order.status } });
  }

  // market data is derived from matching.trades, never guessed from the plan.
  for (const bucket of plan.affectedCandleBuckets) await repairCandle(tx, bucket.symbol, bucket.bucket);
  const symbols = [...new Set(plan.affectedCandleBuckets.map((bucket) => bucket.symbol))];
  for (const symbol of symbols) {
    await tx.$executeRawUnsafe(
      `UPDATE "market"."symbols" s
       SET "last_price" = latest.price
       FROM (
         SELECT price FROM "matching"."trades"
         WHERE symbol = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest
       WHERE s.symbol = $1`,
      symbol,
    );
  }
}

async function countUnsettled(db: Tx): Promise<number> {
  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
     FROM "matching"."trades" t
     LEFT JOIN "account"."processed_events" p ON p.event_id = t.id
     WHERE p.event_id IS NULL`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  // pnpm forwards an explicit argument separator as a literal "--" on
  // Windows. Accept it so the documented `pnpm run ... -- --apply` form is
  // portable across shells and pnpm versions.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help") || args.includes("-h")) return usage();
  const apply = args.includes("--apply");
  const confirmation = args.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm=${APPLY_CONFIRMATION}`);
  }
  if (!apply && args.some((arg) => arg !== "--dry-run")) {
    throw new Error("unknown option (use --help)");
  }

  const prisma = new PrismaClient();
  try {
    const initial = await preflight(prisma);
    report(initial, apply ? "apply" : "dry-run");
    if (!apply) {
      // A blocked dry-run is useful diagnostic output, but must still fail in
      // automation so an unsafe local database is never mistaken for healthy.
      if (initial.plan.issues.length) process.exitCode = 2;
      return;
    }
    if (initial.plan.issues.length) throw new UnsafePlanError("preflight has safety issues");

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5000ms'");
      // pg_advisory_xact_lock returns PostgreSQL's void type, which Prisma
      // cannot deserialize through $queryRawUnsafe. Execute it for its lock
      // side effect instead.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", RECOVERY_ADVISORY_LOCK);
      // Account locks serialize this with the API's balance mutators.
      await lockAllAccounts(tx);
      const fresh = await preflight(tx);
      if (
        fresh.input.unsettledTrades.length !== initial.input.unsettledTrades.length ||
        fresh.fingerprint !== initial.fingerprint
      ) {
        throw new SnapshotChangedError(
          "database changed after dry-run; stop services, run dry-run again, then apply the new fingerprint",
        );
      }
      if (fresh.plan.issues.length) throw new UnsafePlanError("fresh preflight has safety issues");
      await applyPlan(tx, fresh.plan);
    }, { maxWait: 5_000, timeout: 60_000 });

    const remaining = await countUnsettled(prisma);
    console.log(`[recovery] committed. remaining unsettled matching trades: ${remaining}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UnsafePlanError || error instanceof SnapshotChangedError) {
    console.error(`[recovery] not applied: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
