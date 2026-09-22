/**
 * PostgreSQL → Oracle Autonomous Database 아카이브 동기화 (ORDS REST SQL, 드라이버 없음).
 *
 *   ORACLE_ORDS_URL=https://<adb-host>/ords/mockkabu ORACLE_DB_USER=MOCKKABU ORACLE_DB_PASSWORD=... \
 *     pnpm oracle:sync                 # 워터마크 이후 증분
 *   pnpm oracle:sync -- --dry-run      # 문장만 세고 보내지 않음
 *   pnpm oracle:sync -- --full         # 워터마크 무시하고 전부 (MERGE라 중복 없음)
 *
 * 흐름: 사용자 디렉터리 → 1분 봉 → 사용자 낀 체결 → 실현손익 → 자산 스냅샷 순으로, 스트림별
 * 워터마크(mk_sync_state)를 ADB에서 읽어 그 이후 행만 MERGE한다. 한 번에 최대 N행(기본 20,000)만
 * 보내고 다음 실행이 이어받는다. 실패하면 워터마크를 올리지 않으므로 다시 실행하면 된다.
 * 스키마는 deploy/oci/oracle/schema.sql, 설명은 deploy/oci/README.md.
 */
import { PrismaClient } from "@prisma/client";
import { buildMergeStatements, buildWatermarkStatement, SPECS, type MergeSpec, type Row } from "./oracle-sync-plan";

const ORDS_URL = process.env.ORACLE_ORDS_URL?.replace(/\/+$/, "");
const DB_USER = process.env.ORACLE_DB_USER;
const DB_PASSWORD = process.env.ORACLE_DB_PASSWORD;
const MAX_ROWS_PER_RUN = Number(process.env.ORACLE_SYNC_MAX_ROWS ?? 20_000);
const TRADES_DAYS = Number(process.env.ORACLE_SYNC_TRADES_DAYS ?? 3650);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const full = args.has("--full");

const prisma = new PrismaClient();

interface OrdsResponse {
  items?: { statementId: number; statementType?: string; result?: number; errorCode?: number; errorDetails?: string; resultSet?: { items: Record<string, unknown>[] } }[];
}

/** ORDS REST-enabled SQL: POST {ords}/_/sql, 본문은 SQL 텍스트, Basic 인증(스키마 사용자). */
async function ordsSql(sql: string): Promise<OrdsResponse> {
  if (!ORDS_URL || !DB_USER || !DB_PASSWORD) throw new Error("ORACLE_ORDS_URL / ORACLE_DB_USER / ORACLE_DB_PASSWORD 가 필요합니다");
  const response = await fetch(`${ORDS_URL}/_/sql`, {
    method: "POST",
    headers: {
      "content-type": "application/sql",
      authorization: `Basic ${Buffer.from(`${DB_USER}:${DB_PASSWORD}`).toString("base64")}`,
    },
    body: sql,
  });
  if (!response.ok) throw new Error(`ORDS ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as OrdsResponse;
  const failed = body.items?.find((item) => item.errorCode);
  if (failed) throw new Error(`ORDS statement ${failed.statementId} failed: ${failed.errorDetails ?? failed.errorCode}`);
  return body;
}

async function readWatermark(stream: string): Promise<Date> {
  if (full) return new Date(0);
  const body = await ordsSql(`SELECT TO_CHAR(watermark, 'YYYY-MM-DD"T"HH24:MI:SS.FF3') AS w FROM mk_sync_state WHERE stream = '${stream}'`);
  const row = body.items?.[0]?.resultSet?.items?.[0] as { w?: string } | undefined;
  return row?.w ? new Date(`${row.w}Z`) : new Date(0);
}

async function push(stream: string, spec: MergeSpec, rows: Row[], source: Record<string, string>, watermarkOf: (row: Row) => Date) {
  if (rows.length === 0) {
    console.log(`[oracle-sync] ${stream}: 보낼 행 없음`);
    return;
  }
  const statements = buildMergeStatements(spec, rows, source);
  const watermark = rows.reduce((max, row) => (watermarkOf(row) > max ? watermarkOf(row) : max), new Date(0));
  console.log(`[oracle-sync] ${stream}: ${rows.length}행 → MERGE ${statements.length}문 (워터마크 ${watermark.toISOString()})`);
  if (dryRun) return;
  // 한 요청에 여러 문장을 실어도 되지만, 실패 지점을 좁히려고 문장마다 보낸다. 마지막에 워터마크.
  for (const statement of statements) await ordsSql(`${statement};`);
  await ordsSql(`${buildWatermarkStatement(stream, watermark)};`);
}

async function main() {
  if (!ORDS_URL) {
    console.log("[oracle-sync] ORACLE_ORDS_URL 이 없어 건너뜁니다");
    return;
  }
  const limit = Math.max(100, MAX_ROWS_PER_RUN);

  // 0) 계정 디렉터리 — 작아서 매번 전체
  const accounts = await prisma.$queryRaw<Row[]>`
    SELECT a.id AS account_id, u.nickname, u.is_bot, u.created_at
    FROM account.accounts a JOIN auth.users u ON u.id = a.user_id`;
  await push("accounts", SPECS.accounts, accounts, {}, (row) => new Date(row.created_at as Date));

  // 1) 1분 봉
  const candleSince = await readWatermark("candles");
  const candles = await prisma.$queryRaw<Row[]>`
    SELECT symbol, ts, open, high, low, close, volume FROM market.candles
    WHERE interval = '1m' AND ts > ${candleSince} ORDER BY ts ASC LIMIT ${limit}`;
  await push("candles", SPECS.candles, candles, {}, (row) => new Date(row.ts as Date));

  // 2) 사용자 계정이 낀 체결 (봇↔봇 제외)
  const tradesSince = await readWatermark("trades");
  const tradesFloor = new Date(Math.max(tradesSince.getTime(), Date.now() - TRADES_DAYS * 24 * 3_600_000));
  const trades = await prisma.$queryRaw<Row[]>`
    SELECT t.id AS trade_id, t.symbol, t.price, t.qty, t.buyer_account_id, t.seller_account_id, t.taker_side, t.created_at AS traded_at
    FROM matching.trades t
    WHERE t.created_at > ${tradesFloor}
      AND (t.buyer_account_id IN (SELECT a.id FROM account.accounts a JOIN auth.users u ON u.id = a.user_id WHERE NOT u.is_bot)
        OR t.seller_account_id IN (SELECT a.id FROM account.accounts a JOIN auth.users u ON u.id = a.user_id WHERE NOT u.is_bot))
    ORDER BY t.created_at ASC LIMIT ${limit}`;
  await push("trades", SPECS.trades, trades, {}, (row) => new Date(row.traded_at as Date));

  // 3) 실현손익 (사용자 계정만)
  const realizedSince = await readWatermark("realized");
  const realized = await prisma.$queryRaw<Row[]>`
    SELECT r.trade_id, r.account_id, r.symbol, r.qty, r.price, r.cost_basis, r.realized, r.traded_at
    FROM account.realized_pnl r
    WHERE r.traded_at > ${realizedSince}
      AND r.account_id IN (SELECT a.id FROM account.accounts a JOIN auth.users u ON u.id = a.user_id WHERE NOT u.is_bot)
    ORDER BY r.traded_at ASC LIMIT ${limit}`;
  await push("realized", SPECS.realized, realized, {}, (row) => new Date(row.traded_at as Date));

  // 4) 자산 스냅샷
  const equitySince = await readWatermark("equity");
  const equity = await prisma.$queryRaw<Row[]>`
    SELECT account_id, ts, cash, stock_value, equity FROM account.equity_snapshots
    WHERE ts > ${equitySince} ORDER BY ts ASC LIMIT ${limit}`;
  await push("equity", SPECS.equity, equity, {}, (row) => new Date(row.ts as Date));

  console.log(dryRun ? "[oracle-sync] dry-run 끝" : "[oracle-sync] 완료");
}

main()
  .catch((error) => {
    console.error("[oracle-sync] 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
