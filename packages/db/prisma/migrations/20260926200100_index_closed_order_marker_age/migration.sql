-- Same per-minute sweep for close markers (see processed_order_events).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "closed_order_markers_created_at_idx"
  ON "matching"."closed_order_markers" ("created_at");
