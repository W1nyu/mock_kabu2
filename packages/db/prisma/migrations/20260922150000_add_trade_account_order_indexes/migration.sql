-- matching.trades is read by account (my fills, chart markers, leaderboard
-- realized joins) and by order id (bracket average fill, recovery planner),
-- but only had (symbol, created_at). Each of those reads was a sequential scan
-- that grows with the trade ledger; these indexes make them index lookups.
CREATE INDEX IF NOT EXISTS "trades_buyer_account_id_created_at_idx"
  ON "matching"."trades" ("buyer_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "trades_seller_account_id_created_at_idx"
  ON "matching"."trades" ("seller_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "trades_buy_order_id_idx" ON "matching"."trades" ("buy_order_id");
CREATE INDEX IF NOT EXISTS "trades_sell_order_id_idx" ON "matching"."trades" ("sell_order_id");

-- Conditional-order capacity checks count WAITING rows per account.
CREATE INDEX IF NOT EXISTS "conditional_orders_account_id_status_idx"
  ON "order"."conditional_orders" ("account_id", "status");
