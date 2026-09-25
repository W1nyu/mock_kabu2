-- 가상 기초자산(원/달러·원유·천연가스·구리) 1분봉. 값은 실제값 × scale 정수(shared REFERENCE_ASSETS).
-- 선물 일일 정산의 결제가격 근거가 되므로 봇 메모리가 아니라 이 표를 기준으로 삼는다.
CREATE TABLE "market"."reference_candles" (
  "code" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL,
  "open" INTEGER NOT NULL,
  "high" INTEGER NOT NULL,
  "low" INTEGER NOT NULL,
  "close" INTEGER NOT NULL,
  CONSTRAINT "reference_candles_pkey" PRIMARY KEY ("code", "interval", "ts")
);
