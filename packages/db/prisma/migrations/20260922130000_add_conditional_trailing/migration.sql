-- Trailing stops. trail_bps is the distance from the running extreme
-- (watermark: the high since registration for a sell, the low for a buy).
-- trigger_price is kept in sync with the watermark so lists show the live
-- trigger without recomputing it.
ALTER TABLE "order"."conditional_orders" ADD COLUMN "trail_bps" INTEGER;
ALTER TABLE "order"."conditional_orders" ADD COLUMN "watermark" INTEGER;
ALTER TABLE "order"."conditional_orders"
  ADD CONSTRAINT "conditional_orders_trail_bps_check" CHECK ("trail_bps" IS NULL OR ("trail_bps" >= 10 AND "trail_bps" <= 5000));
