-- 선물 일일 정산 기록(1일물). 거래일(KST 날짜)·종목마다 한 행: 최종 결제가격과 정산한 포지션 수·금액.
CREATE TABLE "market"."futures_settlements" (
  "symbol" TEXT NOT NULL,
  "trading_day" TEXT NOT NULL,
  "price" INTEGER NOT NULL,
  "positions" INTEGER NOT NULL DEFAULT 0,
  "realized_total" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_settlements_pkey" PRIMARY KEY ("symbol", "trading_day")
);
