-- Dedicated market makers reconcile only their account-owned OPEN/PARTIAL
-- rows for one symbol. This compound index prevents the query from scanning
-- a long historical order tail as bot activity accumulates.
CREATE INDEX IF NOT EXISTS "orders_account_id_symbol_status_created_at_idx"
  ON "order"."orders" ("account_id", "symbol", "status", "created_at");
