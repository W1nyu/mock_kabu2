-- 뉴스가 움직인 선물 기초자산 코드(USDKRW·OIL·GAS·COPPER·GOLD·CORN). 선물·원자재 화면의 관련 뉴스 필터에 쓴다.
ALTER TABLE "market"."news_items" ADD COLUMN "reference_codes" TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX "news_items_reference_codes_idx" ON "market"."news_items" USING GIN ("reference_codes");
