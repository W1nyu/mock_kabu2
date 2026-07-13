/**
 * 정합성 검사 (스펙 4.4):
 *  1) 계좌별 sum(ledger_entries.delta) == accounts.balance
 *  2) 음수 잔액 / 음수 홀드 / 잔액 초과 홀드 0건
 *  3) 보유 수량 음수 / 보유 초과 홀드(초과 매도 흔적) 0건
 *  4) 심볼별 총 주식 수 보존 리포트
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, detail ?? "");
  }
}

async function main() {
  // 1) 원장 합계 == 잔액
  const mismatches = await prisma.$queryRaw<
    { account_id: string; balance: bigint; ledger_sum: bigint | null }[]
  >`
    SELECT a.id AS account_id, a.balance, COALESCE(l.sum, 0) AS ledger_sum
    FROM account.accounts a
    LEFT JOIN (
      SELECT account_id, SUM(delta) AS sum FROM account.ledger_entries GROUP BY account_id
    ) l ON l.account_id = a.id
    WHERE a.balance <> COALESCE(l.sum, 0)
  `;
  check("ledger sum == balance (전 계좌)", mismatches.length === 0, mismatches);

  // 2) 잔액/홀드 불변식
  const badAccounts = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM account.accounts
    WHERE balance < 0 OR hold_amount < 0 OR hold_amount > balance
  `;
  check("음수 잔액/홀드, 잔액 초과 홀드 0건", badAccounts.length === 0, badAccounts);

  // 3) 보유 수량 불변식
  const badHoldings = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM account.holdings
    WHERE qty < 0 OR hold_qty < 0 OR hold_qty > qty
  `;
  check("음수 보유/보유 초과 홀드 0건", badHoldings.length === 0, badHoldings);

  // 4) 심볼별 총 주식 수 (보존량 리포트 — 발행량은 시드 시점 고정)
  // A trade event uses its trade id as the settlement id.  A short grace period
  // avoids flagging the normal asynchronous hand-off between engine and API.
  const unsettledTrades = await prisma.$queryRaw<
    { id: string; symbol: string; created_at: Date; age_seconds: number }[]
  >`
    SELECT
      t.id,
      t.symbol,
      t.created_at,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - t.created_at))::int AS age_seconds
    FROM matching.trades t
    LEFT JOIN account.processed_events p ON p.event_id = t.id
    WHERE p.event_id IS NULL
      AND t.created_at < CURRENT_TIMESTAMP - INTERVAL '60 seconds'
    ORDER BY t.created_at ASC
    LIMIT 50
  `;
  check("all trades are settled (60s grace)", unsettledTrades.length === 0, unsettledTrades);

  // Keep cash reservations exactly equal to the remaining quantity of active
  // buy orders.  Before an order.closed event is settled, the order remains
  // active in the database, so retaining its reservation is intentional.
  const cashReservationMismatches = await prisma.$queryRaw<
    { account_id: string; actual: bigint; expected: bigint }[]
  >`
    WITH expected AS (
      SELECT
        account_id,
        SUM(hold_per_unit * GREATEST(qty - filled_qty, 0)) AS amount
      FROM "order".orders
      WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIAL')
      GROUP BY account_id
    )
    SELECT
      a.id AS account_id,
      a.hold_amount AS actual,
      COALESCE(e.amount, 0::bigint) AS expected
    FROM account.accounts a
    LEFT JOIN expected e ON e.account_id = a.id
    WHERE a.hold_amount <> COALESCE(e.amount, 0::bigint)
  `;
  check(
    "cash reservations match active buy orders",
    cashReservationMismatches.length === 0,
    cashReservationMismatches,
  );

  // Apply the same invariant to stock reservations for active sell orders.
  const shareReservationMismatches = await prisma.$queryRaw<
    { account_id: string; symbol: string; actual: number; expected: number }[]
  >`
    WITH expected AS (
      SELECT
        account_id,
        symbol,
        SUM(GREATEST(qty - filled_qty, 0))::int AS qty
      FROM "order".orders
      WHERE side = 'SELL' AND status IN ('OPEN', 'PARTIAL')
      GROUP BY account_id, symbol
    )
    SELECT
      COALESCE(h.account_id, e.account_id) AS account_id,
      COALESCE(h.symbol, e.symbol) AS symbol,
      COALESCE(h.hold_qty, 0) AS actual,
      COALESCE(e.qty, 0) AS expected
    FROM account.holdings h
    FULL OUTER JOIN expected e
      ON e.account_id = h.account_id AND e.symbol = h.symbol
    WHERE COALESCE(h.hold_qty, 0) <> COALESCE(e.qty, 0)
  `;
  check(
    "share reservations match active sell orders",
    shareReservationMismatches.length === 0,
    shareReservationMismatches,
  );

  // The cached quote is used by REST clients and must agree with the latest
  // durable trade once the asynchronous pipeline has had time to settle.
  const staleLastPrices = await prisma.$queryRaw<
    { symbol: string; actual: number; expected: number; age_seconds: number }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON (symbol)
        symbol,
        price,
        created_at
      FROM matching.trades
      ORDER BY symbol, created_at DESC, id DESC
    )
    SELECT
      s.symbol,
      s.last_price AS actual,
      l.price AS expected,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - l.created_at))::int AS age_seconds
    FROM market.symbols s
    JOIN latest l ON l.symbol = s.symbol
    WHERE s.last_price <> l.price
      AND l.created_at < CURRENT_TIMESTAMP - INTERVAL '60 seconds'
  `;
  check("cached last price matches latest trade (60s grace)", staleLastPrices.length === 0, staleLastPrices);

  const totals = await prisma.$queryRaw<{ symbol: string; total: bigint }[]>`
    SELECT symbol, SUM(qty) AS total FROM account.holdings GROUP BY symbol ORDER BY symbol
  `;
  for (const t of totals) {
    console.log(`INFO  총 주식 수 ${t.symbol}: ${t.total}`);
  }

  if (failures > 0) {
    console.error(`\n정합성 검사 실패: ${failures}건`);
    process.exit(1);
  }
  console.log("\n정합성 검사 전부 통과");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
