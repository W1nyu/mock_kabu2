-- 1일물 옵션(주가지수·원/달러). 종목은 market.symbols(kind OPTION)에 두어 매칭엔진·체결·봉을 그대로 쓴다.
ALTER TABLE "market"."symbols" DROP CONSTRAINT "symbols_kind_check";
ALTER TABLE "market"."symbols" ADD CONSTRAINT "symbols_kind_check" CHECK ("kind" IN ('STOCK', 'FUTURE', 'OPTION'));

-- 종목별 오늘의 행사가. 이름(KC3 등)은 고정이고 행사가만 매일 04:11 정산 뒤 등가격 기준으로 바뀐다.
CREATE TABLE "market"."option_series" (
  "symbol" TEXT NOT NULL,
  "strike" INTEGER NOT NULL,
  "trading_day" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "option_series_pkey" PRIMARY KEY ("symbol"),
  CONSTRAINT "option_series_strike_check" CHECK ("strike" > 0)
);
