-- 선물 양방향(헤지) 매매: 사람 계정은 롱·숏 포지션을 따로 둔다. 봇·옵션은 NET(순포지션).
-- 1) 주문·조건부 주문 방향 칸 (포지션 이전 전에 — 이전 전 순포지션으로 청산/진입을 판정한다)
ALTER TABLE "order"."orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."conditional_orders" ADD COLUMN "position_side" TEXT;
ALTER TABLE "order"."orders" ADD CONSTRAINT "orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));
ALTER TABLE "order"."conditional_orders" ADD CONSTRAINT "conditional_orders_position_side_check"
  CHECK ("position_side" IS NULL OR "position_side" IN ('LONG', 'SHORT'));

-- 사람 계정의 살아 있는 선물 주문: 순포지션을 줄이고 잔량이 그 포지션 이내면 청산, 그 밖은 진입.
UPDATE "order"."orders" o
SET "position_side" = CASE WHEN o.side = 'BUY' THEN 'LONG' ELSE 'SHORT' END
FROM "account"."accounts" a
JOIN "auth"."users" u ON u.id = a.user_id
WHERE a.id = o.account_id AND u.is_bot = false
  AND o.symbol IN ('KABUF', 'USDF', 'OILF', 'GASF', 'CPRF', 'GOLDF', 'CORNF')
  AND o.status IN ('OPEN', 'PARTIAL');
UPDATE "order"."orders" o
SET "position_side" = CASE
  WHEN o.side = 'SELL' AND p.qty > 0 AND o.qty - o.filled_qty <= p.qty THEN 'LONG'
  WHEN o.side = 'BUY' AND p.qty < 0 AND o.qty - o.filled_qty <= -p.qty THEN 'SHORT'
  WHEN o.side = 'BUY' THEN 'LONG'
  ELSE 'SHORT'
END
FROM "account"."futures_positions" p
WHERE p.account_id = o.account_id AND p.symbol = o.symbol AND o.position_side IS NOT NULL
  AND o.status IN ('OPEN', 'PARTIAL');

-- 진입으로 바뀌었는데 증거금을 묶지 않은(청산으로 접수됐던) 주문은 취소 요청한다.
INSERT INTO "order"."outbox" ("event_id", "topic", "payload")
SELECT e.id, 'order.cancel.requested',
  jsonb_build_object('topic', 'order.cancel.requested', 'eventId', e.id, 'orderId', o.id, 'symbol', o.symbol,
                     'ts', (extract(epoch FROM now()) * 1000)::bigint)
FROM "order"."orders" o
CROSS JOIN LATERAL (SELECT gen_random_uuid()::text AS id) e
WHERE o.position_side IS NOT NULL AND o.status IN ('OPEN', 'PARTIAL') AND o.hold_per_unit = 0
  AND ((o.side = 'BUY' AND o.position_side = 'LONG') OR (o.side = 'SELL' AND o.position_side = 'SHORT'));

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
