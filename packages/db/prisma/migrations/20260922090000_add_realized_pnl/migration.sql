-- Realized profit/loss per sell fill.
--
-- The settlement consumer writes one row in the same transaction that reduces
-- holdings.cost_basis proportionally, so sum(realized) + remaining cost_basis
-- always equals the total purchase cost. Sells that settled before this table
-- existed have no row; the API reports totals from this point on.
CREATE TABLE "account"."realized_pnl" (
  "id" BIGSERIAL NOT NULL,
  "account_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "trade_id" TEXT NOT NULL,
  "qty" INTEGER NOT NULL,
  "price" INTEGER NOT NULL,
  "cost_basis" BIGINT NOT NULL,
  "realized" BIGINT NOT NULL,
  "traded_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "realized_pnl_pkey" PRIMARY KEY ("id")
);

-- A redelivered trade event must not realize the same sale twice.
CREATE UNIQUE INDEX "realized_pnl_trade_id_key" ON "account"."realized_pnl" ("trade_id");

-- Dashboard reads "today" and "all time" totals per account, newest first.
CREATE INDEX "realized_pnl_account_id_traded_at_idx" ON "account"."realized_pnl" ("account_id", "traded_at");

-- Per-symbol breakdown on the position bar.
CREATE INDEX "realized_pnl_account_id_symbol_idx" ON "account"."realized_pnl" ("account_id", "symbol");
