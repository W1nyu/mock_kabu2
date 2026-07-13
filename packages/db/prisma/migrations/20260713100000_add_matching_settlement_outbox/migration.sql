-- Matching trade rows and their settlement notifications must survive the
-- gap between a PostgreSQL commit and Redis XADD.  The matching engine writes
-- these rows in the same transaction as matching.trades and relays only
-- unpublished rows in sequence order.
CREATE TABLE "matching"."outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_events_event_id_key"
  ON "matching"."outbox_events"("event_id");

CREATE INDEX "outbox_events_published_at_id_idx"
  ON "matching"."outbox_events"("published_at", "id");
