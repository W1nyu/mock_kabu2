/**
 * PostgreSQL 행을 Oracle MERGE 문으로 바꾸는 순수 계획기. 네트워크·DB 없이 테스트한다.
 *
 * ORDS REST SQL은 SQL 텍스트를 받으므로 값을 리터럴로 박는다. 문자열은 따옴표를 두 번 써서
 * 이스케이프하고, 시각은 TO_TIMESTAMP(ISO, FF3)로, 숫자는 유한한 정수만 허용한다. 한 MERGE에
 * 여러 행을 `SELECT … FROM DUAL UNION ALL …`로 묶어 요청 수를 줄인다(기본 200행).
 */
export interface OracleColumn {
  /** Oracle 컬럼명 */
  name: string;
  kind: "string" | "number" | "timestamp";
}

export interface MergeSpec {
  table: string;
  keys: string[];
  columns: OracleColumn[];
}

export type Row = Record<string, string | number | bigint | boolean | Date | null | undefined>;

export const MERGE_BATCH_ROWS = 200;

export function oracleLiteral(kind: OracleColumn["kind"], value: Row[string]): string {
  if (value == null) return "NULL";
  switch (kind) {
    case "string":
      return `'${String(value).replace(/'/g, "''")}'`;
    case "number": {
      const n = typeof value === "bigint" ? Number(value) : typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
      if (!Number.isFinite(n)) throw new Error(`non-finite number for oracle literal: ${String(value)}`);
      return Number.isInteger(n) ? String(n) : n.toFixed(6);
    }
    case "timestamp": {
      const date = value instanceof Date ? value : new Date(value as string | number);
      if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp for oracle literal: ${String(value)}`);
      return `TO_TIMESTAMP('${date.toISOString().slice(0, 23)}', 'YYYY-MM-DD"T"HH24:MI:SS.FF3')`;
    }
  }
}

/** rows(카멜/스네이크 무관, `source` 키로 지정)를 MERGE 문 배열로. 빈 입력은 빈 배열. */
export function buildMergeStatements(
  spec: MergeSpec,
  rows: Row[],
  source: Record<string, string>,
  batchRows = MERGE_BATCH_ROWS,
): string[] {
  const statements: string[] = [];
  const columnList = spec.columns.map((c) => c.name);
  const nonKeys = columnList.filter((name) => !spec.keys.includes(name));
  for (let start = 0; start < rows.length; start += batchRows) {
    const batch = rows.slice(start, start + batchRows);
    const selects = batch.map((row) => {
      const values = spec.columns.map((c) => `${oracleLiteral(c.kind, row[source[c.name] ?? c.name])} AS ${c.name}`);
      return `SELECT ${values.join(", ")} FROM DUAL`;
    });
    const on = spec.keys.map((k) => `t.${k} = s.${k}`).join(" AND ");
    const update = nonKeys.length > 0 ? ` WHEN MATCHED THEN UPDATE SET ${nonKeys.map((c) => `t.${c} = s.${c}`).join(", ")}` : "";
    statements.push(
      `MERGE INTO ${spec.table} t USING (${selects.join(" UNION ALL ")}) s ON (${on})${update}` +
        ` WHEN NOT MATCHED THEN INSERT (${columnList.join(", ")}) VALUES (${columnList.map((c) => `s.${c}`).join(", ")})`,
    );
  }
  return statements;
}

/** 워터마크 갱신 문. 스트림별 마지막 동기화 시각을 ADB에 남겨 재시작해도 이어서 받는다. */
export function buildWatermarkStatement(stream: string, watermark: Date): string {
  return (
    `MERGE INTO mk_sync_state t USING (SELECT '${stream}' AS stream FROM DUAL) s ON (t.stream = s.stream)` +
    ` WHEN MATCHED THEN UPDATE SET t.watermark = ${oracleLiteral("timestamp", watermark)}, t.updated_at = SYSTIMESTAMP` +
    ` WHEN NOT MATCHED THEN INSERT (stream, watermark) VALUES (s.stream, ${oracleLiteral("timestamp", watermark)})`
  );
}

export const SPECS = {
  candles: {
    table: "mk_candles",
    keys: ["symbol", "ts"],
    columns: [
      { name: "symbol", kind: "string" },
      { name: "ts", kind: "timestamp" },
      { name: "open", kind: "number" },
      { name: "high", kind: "number" },
      { name: "low", kind: "number" },
      { name: "close", kind: "number" },
      { name: "volume", kind: "number" },
    ],
  },
  trades: {
    table: "mk_trades",
    keys: ["trade_id"],
    columns: [
      { name: "trade_id", kind: "string" },
      { name: "symbol", kind: "string" },
      { name: "price", kind: "number" },
      { name: "qty", kind: "number" },
      { name: "buyer_account_id", kind: "string" },
      { name: "seller_account_id", kind: "string" },
      { name: "taker_side", kind: "string" },
      { name: "traded_at", kind: "timestamp" },
    ],
  },
  realized: {
    table: "mk_realized_pnl",
    keys: ["trade_id"],
    columns: [
      { name: "trade_id", kind: "string" },
      { name: "account_id", kind: "string" },
      { name: "symbol", kind: "string" },
      { name: "qty", kind: "number" },
      { name: "price", kind: "number" },
      { name: "cost_basis", kind: "number" },
      { name: "realized", kind: "number" },
      { name: "traded_at", kind: "timestamp" },
    ],
  },
  equity: {
    table: "mk_equity_snapshots",
    keys: ["account_id", "ts"],
    columns: [
      { name: "account_id", kind: "string" },
      { name: "ts", kind: "timestamp" },
      { name: "cash", kind: "number" },
      { name: "stock_value", kind: "number" },
      { name: "equity", kind: "number" },
    ],
  },
  accounts: {
    table: "mk_accounts",
    keys: ["account_id"],
    columns: [
      { name: "account_id", kind: "string" },
      { name: "nickname", kind: "string" },
      { name: "is_bot", kind: "number" },
      { name: "created_at", kind: "timestamp" },
    ],
  },
} satisfies Record<string, MergeSpec>;
