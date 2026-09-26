-- The matching engine sweeps week-old order claims every minute. Without an
-- index on the age column each sweep scanned the whole table (~900MB).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "processed_order_events_processed_at_idx"
  ON "matching"."processed_order_events" ("processed_at");
