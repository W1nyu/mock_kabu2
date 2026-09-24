-- 시가총액 가중 지수: 종목별 발행주식수, 재상장 시각, 지수 구간(제수).
ALTER TABLE "market"."symbols"
  ADD COLUMN "listed_shares" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "listed_at" TIMESTAMP(3);

-- 상장 시가총액이 종목마다 1.2조 원이 되도록 정한 발행주식수 (shared SYMBOLS.listedShares와 같음).
UPDATE "market"."symbols" SET "listed_shares" = CASE "symbol"
  WHEN 'MOCK' THEN 24000000
  WHEN 'KABU' THEN 10000000
  WHEN 'TANU' THEN 150000000
  WHEN 'SAKU' THEN 4000000
  WHEN 'NEKO' THEN 48000000
  ELSE "listed_shares" END;

CREATE TABLE "market"."index_epochs" (
  "starts_at" TIMESTAMP(3) NOT NULL,
  "divisor" DOUBLE PRECISION NOT NULL,
  "members" TEXT[] NOT NULL,
  CONSTRAINT "index_epochs_pkey" PRIMARY KEY ("starts_at")
);

-- 첫 구간: 상장가 기준 시가총액 합이 지수 1,000. 종목이 아직 없으면(새 DB) 시드가 만든다.
INSERT INTO "market"."index_epochs" ("starts_at", "divisor", "members")
SELECT TIMESTAMP '1970-01-01 00:00:00', SUM("initial_price"::double precision * "listed_shares") / 1000, ARRAY_AGG("symbol" ORDER BY "symbol")
FROM "market"."symbols"
WHERE "symbol" IN ('MOCK', 'KABU', 'TANU', 'SAKU', 'NEKO') AND "listed_shares" > 0
HAVING COUNT(*) > 0;
