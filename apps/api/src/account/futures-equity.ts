import { Prisma } from "@mock-kabu/db";
import { FUTURES } from "@mock-kabu/shared";

/**
 * 계좌별 선물 평가 몫(원) = 열린 포지션의 평가손익 − 미수금.
 * 대시보드 총 자산(현금 + 주식 + 선물 평가손익 − 미수금)과 같은 식을 랭킹·자산 스냅샷도 쓰게 하는 SQL 조각.
 * 평가 가격은 선물 최근 체결가(market.symbols.last_price) — /account/futures와 같다.
 * 결과 컬럼: account_id, futures_value
 */
export function futuresValueSql(): Prisma.Sql {
  const unitValues = Prisma.join(FUTURES.map((f) => Prisma.sql`(${f.symbol}, ${f.unitValue}::bigint)`));
  return Prisma.sql`
    SELECT acc.account_id, COALESCE(pos.unrealized, 0) - COALESCE(debt.amount, 0) AS futures_value
    FROM (
      SELECT account_id FROM account.futures_positions WHERE qty <> 0
      UNION SELECT account_id FROM account.futures_debts WHERE amount > 0
    ) acc
    LEFT JOIN (
      SELECT p.account_id,
        SUM(SIGN(p.qty)::bigint * (ABS(p.qty)::bigint * s.last_price - p.entry_value) * uv.unit_value) AS unrealized
      FROM account.futures_positions p
      JOIN market.symbols s ON s.symbol = p.symbol
      JOIN (VALUES ${unitValues}) AS uv(symbol, unit_value) ON uv.symbol = p.symbol
      WHERE p.qty <> 0
      GROUP BY p.account_id
    ) pos ON pos.account_id = acc.account_id
    LEFT JOIN account.futures_debts debt ON debt.account_id = acc.account_id
  `;
}
