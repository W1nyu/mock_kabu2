-- Conditional (stop / take-profit / breakout) orders.
--
-- Nothing is reserved while a row is WAITING. When a trade print satisfies the
-- condition the API claims the row (WAITING -> TRIGGERED, exactly once) and
-- then places an ordinary order through the normal reservation path. A failed
-- placement is recorded as FAILED with the reason so the user can see why.
CREATE TABLE "order"."conditional_orders" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "trigger_price" INTEGER NOT NULL,
  "qty" INTEGER NOT NULL,
  "order_type" TEXT NOT NULL,
  "limit_price" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "triggered_order_id" TEXT,
  "trigger_trade_price" INTEGER,
  "fail_reason" TEXT,
  "triggered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conditional_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conditional_orders_side_check" CHECK ("side" IN ('BUY', 'SELL')),
  CONSTRAINT "conditional_orders_direction_check" CHECK ("direction" IN ('AT_OR_ABOVE', 'AT_OR_BELOW')),
  CONSTRAINT "conditional_orders_qty_check" CHECK ("qty" > 0),
  CONSTRAINT "conditional_orders_trigger_price_check" CHECK ("trigger_price" > 0)
);

-- The trigger loop scans one symbol's WAITING rows on every trade print.
CREATE INDEX "conditional_orders_symbol_status_idx" ON "order"."conditional_orders" ("symbol", "status");

-- The trade page lists an account's own rows newest first.
CREATE INDEX "conditional_orders_account_id_created_at_idx" ON "order"."conditional_orders" ("account_id", "created_at");
