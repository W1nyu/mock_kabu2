-- 산업군 뉴스: 특정 종목이 아니라 산업군(shared INDUSTRIES id) 전체에 대한 기사. 종목·시장 전체 기사는 null.
ALTER TABLE "market"."news_items" ADD COLUMN "industry" TEXT;

CREATE INDEX "news_items_industry_created_at_idx" ON "market"."news_items" ("industry", "created_at");
