-- 선물 4단계: 추가증거금(마진콜)과 반대매매 기록.
-- 계좌마다 진행 중인 추가증거금은 하나(resolved_at IS NULL). 결과: RESOLVED(해소)·LIQUIDATED(기한 초과 비율 반대매매)·
-- EMERGENCY(급변 전량 반대매매)·SETTLED(일일 정산으로 포지션 소멸).
CREATE TABLE "account"."futures_margin_calls" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadline" TIMESTAMP(3) NOT NULL,
  "required" BIGINT NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "outcome" TEXT,
  CONSTRAINT "futures_margin_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "futures_margin_calls_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('RESOLVED', 'LIQUIDATED', 'EMERGENCY', 'SETTLED'))
);
CREATE UNIQUE INDEX "futures_margin_calls_one_active" ON "account"."futures_margin_calls" ("account_id") WHERE "resolved_at" IS NULL;
CREATE INDEX "futures_margin_calls_account_started_idx" ON "account"."futures_margin_calls" ("account_id", "started_at");

-- 반대매매로 낸 주문(증거금을 묶지 않는 시장가). 주문 내역에서 일반 주문과 구분해 보여 준다.
CREATE TABLE "account"."futures_liquidations" (
  "order_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "qty" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "margin_call_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_liquidations_pkey" PRIMARY KEY ("order_id"),
  CONSTRAINT "futures_liquidations_reason_check" CHECK ("reason" IN ('DEADLINE', 'EMERGENCY'))
);
CREATE INDEX "futures_liquidations_account_created_idx" ON "account"."futures_liquidations" ("account_id", "created_at");
