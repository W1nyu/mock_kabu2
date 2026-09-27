-- 종목 없이 내 미체결 주문만 최신순으로 보는 조회(/orders?live). 봇 계정은 주문이 수십만 건이라
-- (account_id, symbol, status, created_at) 인덱스로는 종목마다 훑고 정렬해 1회 ~110ms가 걸렸다.
-- 미체결 주문만 담는 부분 인덱스라 크기도 작다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_live_account_created_idx"
  ON "order"."orders" ("account_id", "created_at" DESC)
  WHERE "status" IN ('OPEN', 'PARTIAL');
