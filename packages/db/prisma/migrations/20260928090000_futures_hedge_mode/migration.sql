-- 선물 양방향(헤지) 매매: 사람 계정은 롱·숏 포지션을 따로 둔다. 봇·옵션은 NET(순포지션).
-- 1) 주문·조건부 주문 방향 칸 (포지션 이전 전에 — 이전 전 순포지션으로 청산/진입을 판정한다)
ALTER TABLE "order"."orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."conditional_orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));
ALTER TABLE "order"."conditional_orders" ADD CONSTRAINT "conditional_orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));

-- 사람 계정의 살아 있는 선물 주문: 먼저 모두 진입 방향(매수 = 롱, 매도 = 숏)으로 둔다.
-- 다음 UPDATE가 증거금 없이 순포지션을 줄이는 주문을 (created_at, id) 순으로 누적해 순포지션 이내인 것만 청산으로 바꾼다.
UPDATE "order"."orders" o
SET "position_side" = CASE WHEN o.side = 'BUY' THEN 'LONG' ELSE 'SHORT' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = o.account_id AND u.is_bot = false
  AND o.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF')
  AND o.status IN ('OPEN', 'PARTIAL');
-- 증거금을 묶은(hold_per_unit > 0) 주문은 첫 UPDATE가 정한 진입 방향을 그대로 둔다.
-- hold_per_unit = 0인 주문만 청산 후보이며, 그중에서도 순포지션을 줄이는 방향(SELL이면 순롱, BUY면 순숏)만 후보다.
-- 후보를 (created_at, id) 순으로 누적해 순포지션 절대값 이내인 만큼만 청산으로 인정한다 — 옛(양방향 이전) 모델의 "누적 청산" 판정을 그대로 재현.
-- 누적 한도를 넘어 못 들어간 후보는 첫 UPDATE의 진입 방향에 그대로 남고, 뒤의 취소 INSERT가 그 주문들을 잡아낸다.
UPDATE "order"."orders" o
SET "position_side" = CASE WHEN cand.side = 'SELL' THEN 'LONG' ELSE 'SHORT' END
FROM (
  SELECT o2.id, o2.side,
    SUM(o2.qty - o2.filled_qty) OVER (
      PARTITION BY o2.account_id, o2.symbol ORDER BY o2.created_at, o2.id
    ) AS running_qty,
    ABS(p.qty) AS net_qty_abs
  FROM "order"."orders" o2
  JOIN "account"."futures_positions" p
    ON p.account_id = o2.account_id AND p.symbol = o2.symbol
  WHERE o2.position_side IS NOT NULL
    AND o2.status IN ('OPEN', 'PARTIAL')
    AND o2.hold_per_unit = 0
    AND ((o2.side = 'SELL' AND p.qty > 0) OR (o2.side = 'BUY' AND p.qty < 0))
) cand
WHERE cand.id = o.id AND cand.running_qty <= cand.net_qty_abs;

-- 진입으로 남았는데(위 청산 판정에 들지 못했거나 원래 진입 방향인) 증거금을 묶지 않은 주문은 취소 요청한다.
-- 이 취소 행은 API 아웃박스 릴레이어가 발행한다: 배포는 점검 시간(신규 주문 없음, 봇 정지)에 실행하고,
-- 점검이 끝나기 전에 릴레이어가 이 행들을 모두 발행해야 한다(그 전엔 옛 증거금 없는 주문이 살아 있을 수 있다).
INSERT INTO "order"."outbox" ("event_id", "topic", "payload")
-- 이벤트 ID는 행마다 한 번 만든다(비상관 LATERAL은 한 번만 평가될 수 있어 ID가 겹친다).
-- MATERIALIZED로 고정해 event_id와 payload.eventId가 같은 값을 쓰게 한다.
WITH x AS MATERIALIZED (
  SELECT gen_random_uuid()::text AS eid, o.id, o.symbol
  FROM "order"."orders" o
  WHERE o.position_side IS NOT NULL AND o.status IN ('OPEN', 'PARTIAL') AND o.hold_per_unit = 0
    AND ((o.side = 'BUY' AND o.position_side = 'LONG') OR (o.side = 'SELL' AND o.position_side = 'SHORT'))
)
SELECT x.eid, 'order.cancel.requested',
  jsonb_build_object('topic', 'order.cancel.requested', 'eventId', x.eid, 'orderId', x.id, 'symbol', x.symbol,
                     'ts', (extract(epoch FROM now()) * 1000)::bigint)
FROM x;

-- 사람 계정의 대기 중인 선물 조건부 주문은 늘 청산이다: 매도 = 롱 청산, 매수 = 숏 청산.
UPDATE "order"."conditional_orders" c
SET "position_side" = CASE WHEN c.side = 'SELL' THEN 'LONG' ELSE 'SHORT' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = c.account_id AND u.is_bot = false
  AND c.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF')
  AND c.status = 'WAITING';

-- 2) 포지션 방향 칸·기본키
ALTER TABLE "account"."futures_positions" ADD COLUMN "position_side" TEXT NOT NULL DEFAULT 'NET';
ALTER TABLE "account"."futures_positions" DROP CONSTRAINT "futures_positions_pkey";
UPDATE "account"."futures_positions" p
SET "position_side" = CASE WHEN p.qty < 0 THEN 'SHORT' ELSE 'LONG' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = p.account_id AND u.is_bot = false
  AND p.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF');
ALTER TABLE "account"."futures_positions"
  ADD CONSTRAINT "futures_positions_pkey" PRIMARY KEY ("account_id", "symbol", "position_side");
-- 레버리지 설정을 반대 방향 행에도 둔다(롱·숏이 같은 레버리지를 쓴다).
INSERT INTO "account"."futures_positions" ("account_id", "symbol", "position_side", "qty", "entry_value", "margin_held", "leverage", "updated_at")
SELECT account_id, symbol, CASE WHEN position_side = 'LONG' THEN 'SHORT' ELSE 'LONG' END, 0, 0, 0, leverage, now()
FROM "account"."futures_positions"
WHERE position_side IN ('LONG', 'SHORT')
ON CONFLICT DO NOTHING;
ALTER TABLE "account"."futures_positions" ADD CONSTRAINT "futures_positions_side_check" CHECK (
  ("position_side" = 'NET') OR ("position_side" = 'LONG' AND "qty" >= 0) OR ("position_side" = 'SHORT' AND "qty" <= 0)
);
