-- Keep the historical settlement-claim sweep from scanning the whole table.
-- PostgreSQL permits this to run while settlement continues to insert claims.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "processed_events_processed_at_idx"
  ON "account"."processed_events" ("processed_at");
