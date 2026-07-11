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
