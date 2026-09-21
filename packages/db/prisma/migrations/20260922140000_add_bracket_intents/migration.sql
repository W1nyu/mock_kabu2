-- "Arm stop/take-profit after this buy fills" intents.
--
-- The API polls PENDING rows; once the parent order is terminal it creates an
-- OCO pair at the average fill price (ARMED) or closes the intent (CANCELED)
-- when nothing filled. order_id is unique so a retry cannot arm twice.
CREATE TABLE "order"."bracket_intents" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "stop_bps" INTEGER NOT NULL,
  "take_bps" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "armed_qty" INTEGER NOT NULL DEFAULT 0,
  "avg_fill_price" INTEGER,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bracket_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bracket_intents_stop_bps_check" CHECK ("stop_bps" >= 10 AND "stop_bps" <= 5000),
  CONSTRAINT "bracket_intents_take_bps_check" CHECK ("take_bps" >= 10 AND "take_bps" <= 10000)
);

CREATE UNIQUE INDEX "bracket_intents_order_id_key" ON "order"."bracket_intents" ("order_id");
CREATE INDEX "bracket_intents_status_idx" ON "order"."bracket_intents" ("status");
CREATE INDEX "bracket_intents_account_id_created_at_idx" ON "order"."bracket_intents" ("account_id", "created_at");
