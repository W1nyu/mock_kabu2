-- Per-minute equity snapshots for user (non-bot) accounts.
--
-- The API writes one row per account per minute (cash + holdings marked at
-- market.symbols.last_price). The dashboard equity curve reads them back in
-- coarser buckets for longer ranges. The unique key keeps two API replicas
-- from double-writing the same minute.
CREATE TABLE "account"."equity_snapshots" (
  "id" BIGSERIAL NOT NULL,
  "account_id" TEXT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL,
  "cash" BIGINT NOT NULL,
  "stock_value" BIGINT NOT NULL,
  "equity" BIGINT NOT NULL,

  CONSTRAINT "equity_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "equity_snapshots_account_id_ts_key" ON "account"."equity_snapshots" ("account_id", "ts");
