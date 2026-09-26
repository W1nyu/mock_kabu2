-- 뉴스 영어·일본어 번역 {"en":{"headline","body"},"ja":{...}}. 봇이 한국어 기사와 함께 만든다(옛 기사는 빈 객체 → 한국어로 표시).
ALTER TABLE "market"."news_items" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}';
