-- An order can remain OPEN/PARTIAL until the asynchronous account settlement
-- consumes its order.closed event. Keep the matching-side close decision in
-- the same transaction as the settlement outbox so a restarted engine never
-- replays that in-between order back into its executable book.
CREATE TABLE "matching"."closed_order_markers" (
    "order_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closed_order_markers_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "closed_order_markers_event_id_key" UNIQUE ("event_id")
);
