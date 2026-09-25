-- 선물 2단계: 종목 종류 구분, 포지션, 실현손익.
-- 선물도 market.symbols에 두어 매칭엔진·체결·봉을 그대로 쓰고, 현물 전용 조회는 kind='STOCK'으로 거른다.
ALTER TABLE "market"."symbols" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STOCK';
ALTER TABLE "market"."symbols" ADD CONSTRAINT "symbols_kind_check" CHECK ("kind" IN ('STOCK', 'FUTURE'));

-- 계좌·종목별 선물 포지션. qty는 부호 있음(+롱, −숏), entry_value는 Σ(진입가 × 계약 수) 정수 가격 단위.
-- margin_held는 이 포지션에 묶인 위탁증거금(원) — 주문 가능 금액 = 잔액 − 묶음 − Σ margin_held.
CREATE TABLE "account"."futures_positions" (
  "account_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "qty" INTEGER NOT NULL DEFAULT 0,
  "entry_value" BIGINT NOT NULL DEFAULT 0,
  "margin_held" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_positions_pkey" PRIMARY KEY ("account_id", "symbol"),
  CONSTRAINT "futures_positions_entry_check" CHECK ("entry_value" >= 0 AND "margin_held" >= 0),
  CONSTRAINT "futures_positions_flat_check" CHECK ("qty" <> 0 OR ("entry_value" = 0 AND "margin_held" = 0))
);

-- 선물 청산 실현손익. 체결 한 건에 계좌당 한 행(자기 체결이면 매수·매도 두 행).
CREATE TABLE "account"."futures_realized" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "trade_id" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "closed_qty" INTEGER NOT NULL,
  "price" INTEGER NOT NULL,
  "realized" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_realized_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "futures_realized_trade_side_key" ON "account"."futures_realized" ("trade_id", "side");
CREATE INDEX "futures_realized_account_created_idx" ON "account"."futures_realized" ("account_id", "created_at");

-- 선물 미수금(원). 손실이 잔액(− 주문 증거금)을 넘으면 넘는 부분을 여기 쌓는다 — 잔액은 음수가 될 수 없다.
-- 이후 선물 이익이 나면 먼저 갚고, 남아 있는 동안은 주문 가능 금액에서 빠져 새 주문이 막힌다.
CREATE TABLE "account"."futures_debts" (
  "account_id" TEXT NOT NULL,
  "amount" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_debts_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "futures_debts_amount_check" CHECK ("amount" >= 0)
);
