-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "account";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "market";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "matching";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "order";

-- CreateTable
CREATE TABLE "auth"."users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "hold_amount" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."holdings" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "hold_qty" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "ref_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."processed_events" (
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "order"."orders" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" INTEGER,
    "qty" INTEGER NOT NULL,
    "filled_qty" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "hold_per_unit" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order"."outbox" (
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "matching"."trades" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "buy_order_id" TEXT NOT NULL,
    "sell_order_id" TEXT NOT NULL,
    "buyer_account_id" TEXT NOT NULL,
    "seller_account_id" TEXT NOT NULL,
    "taker_side" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market"."symbols" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initial_price" INTEGER NOT NULL,
    "tick_size" INTEGER NOT NULL,
    "last_price" INTEGER NOT NULL,

    CONSTRAINT "symbols_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "market"."candles" (
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "open" INTEGER NOT NULL,
    "high" INTEGER NOT NULL,
    "low" INTEGER NOT NULL,
    "close" INTEGER NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("symbol","interval","ts")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "auth"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_user_id_key" ON "account"."accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "holdings_account_id_symbol_key" ON "account"."holdings"("account_id", "symbol");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_idx" ON "account"."ledger_entries"("account_id");

-- CreateIndex
CREATE INDEX "orders_account_id_created_at_idx" ON "order"."orders"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_symbol_status_idx" ON "order"."orders"("symbol", "status");

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "order"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "trades_symbol_created_at_idx" ON "matching"."trades"("symbol", "created_at");

-- AddForeignKey
ALTER TABLE "account"."holdings" ADD CONSTRAINT "holdings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 스펙 4.3 추가 안전망: 락이 뚫려도 DB 레벨에서 최종 차단하는 CHECK 제약
ALTER TABLE "account"."accounts"
  ADD CONSTRAINT "accounts_balance_non_negative" CHECK ("balance" >= 0),
  ADD CONSTRAINT "accounts_hold_non_negative" CHECK ("hold_amount" >= 0),
  ADD CONSTRAINT "accounts_hold_within_balance" CHECK ("hold_amount" <= "balance");

ALTER TABLE "account"."holdings"
  ADD CONSTRAINT "holdings_qty_non_negative" CHECK ("qty" >= 0),
  ADD CONSTRAINT "holdings_hold_qty_non_negative" CHECK ("hold_qty" >= 0),
  ADD CONSTRAINT "holdings_hold_within_qty" CHECK ("hold_qty" <= "qty");
