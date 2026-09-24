CREATE TABLE "account"."admin_distributions" (
  "request_id" UUID NOT NULL,
  "account_id" TEXT NOT NULL,
  "amount_each" BIGINT NOT NULL,
  "recipient_count" INTEGER NOT NULL DEFAULT 0,
  "total" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_distributions_pkey" PRIMARY KEY ("request_id"),
  CONSTRAINT "admin_distributions_amount_check" CHECK ("amount_each" > 0 AND "recipient_count" >= 0 AND "total" >= 0)
);
