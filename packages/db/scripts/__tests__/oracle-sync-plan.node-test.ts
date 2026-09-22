import assert from "node:assert/strict";
import test from "node:test";
import { buildMergeStatements, buildWatermarkStatement, oracleLiteral, SPECS } from "../oracle-sync-plan";

test("literals: strings are quote-escaped, timestamps use FF3, bigint becomes a plain number", () => {
  assert.equal(oracleLiteral("string", "O'Reilly"), "'O''Reilly'");
  assert.equal(oracleLiteral("number", 12345678901234n), "12345678901234");
  assert.equal(oracleLiteral("number", true), "1");
  assert.equal(
    oracleLiteral("timestamp", new Date("2026-09-22T01:02:03.456Z")),
    "TO_TIMESTAMP('2026-09-22T01:02:03.456', 'YYYY-MM-DD\"T\"HH24:MI:SS.FF3')",
  );
  assert.equal(oracleLiteral("string", null), "NULL");
  assert.throws(() => oracleLiteral("number", Number.NaN));
});

test("merge batches rows, keys drive ON, non-keys drive UPDATE", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    symbol: "KABU",
    ts: new Date(Date.UTC(2026, 8, 22, 0, i)),
    open: 100 + i,
    high: 110,
    low: 90,
    close: 105,
    volume: 10n,
  }));
  const statements = buildMergeStatements(SPECS.candles, rows, {}, 2);
  assert.equal(statements.length, 2); // 2 + 1
  assert.match(statements[0], /^MERGE INTO mk_candles t USING \(SELECT 'KABU' AS symbol, TO_TIMESTAMP/);
  assert.match(statements[0], / UNION ALL SELECT /);
  assert.match(statements[0], /ON \(t\.symbol = s\.symbol AND t\.ts = s\.ts\)/);
  assert.match(statements[0], /WHEN MATCHED THEN UPDATE SET t\.open = s\.open, t\.high = s\.high/);
  assert.doesNotMatch(statements[0], /UPDATE SET[^W]*t\.symbol = s\.symbol/);
  assert.match(statements[1], /INSERT \(symbol, ts, open, high, low, close, volume\) VALUES \(s\.symbol/);
  assert.equal(buildMergeStatements(SPECS.candles, [], {}).length, 0);
});

test("source mapping lets postgres column names differ from oracle ones", () => {
  const [statement] = buildMergeStatements(SPECS.accounts, [{ account_id: "a", nickname: "테스터", is_bot: false, created_at: new Date(0) }], {});
  assert.match(statement, /'테스터' AS nickname, 0 AS is_bot/);
});

test("watermark statement upserts the stream row", () => {
  const sql = buildWatermarkStatement("candles", new Date("2026-09-22T00:00:00.000Z"));
  assert.match(sql, /MERGE INTO mk_sync_state/);
  assert.match(sql, /SELECT 'candles' AS stream FROM DUAL/);
  assert.match(sql, /t\.watermark = TO_TIMESTAMP\('2026-09-22T00:00:00\.000'/);
});
