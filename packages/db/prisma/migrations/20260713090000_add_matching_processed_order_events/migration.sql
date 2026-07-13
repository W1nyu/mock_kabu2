-- Redis Streams orders consumer의 at-least-once 중복 전달을 DB 레벨에서 차단한다.
-- matching-engine은 체결 원장/last_price와 이 event_id insert를 같은 트랜잭션으로 확정한다.
CREATE TABLE "matching"."processed_order_events" (
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_order_events_pkey" PRIMARY KEY ("event_id")
);
