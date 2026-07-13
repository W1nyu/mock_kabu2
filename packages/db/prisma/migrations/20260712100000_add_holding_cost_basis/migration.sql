-- Holding에 총 매입원가 컬럼 추가 (평단가 = cost_basis / qty)
ALTER TABLE "account"."holdings" ADD COLUMN "cost_basis" BIGINT NOT NULL DEFAULT 0;

-- 기존 보유분 백필: 정확한 매입 이력이 없으므로 종목 기준가(initial_price)로 근사
UPDATE "account"."holdings" h
SET "cost_basis" = h."qty"::bigint * s."initial_price"
FROM "market"."symbols" s
WHERE h."symbol" = s."symbol" AND h."qty" > 0;
