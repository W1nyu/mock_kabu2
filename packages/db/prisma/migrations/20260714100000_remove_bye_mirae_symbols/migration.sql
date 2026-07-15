-- Delist the two experimental symbols while preserving settled order/trade
-- history for audit. The active reservations are released before their orders
-- become terminal, so no account is left with cash or shares locked in a
-- market that no longer exists.
--
-- Do not run this while a BYE/MIRAE settlement event is still in flight: a
-- later settlement could otherwise release the same reservation twice.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "matching"."outbox_events" AS outbox
    LEFT JOIN "account"."processed_events" AS processed
      ON processed."event_id" = outbox."event_id"
    WHERE outbox."payload" ->> 'symbol' IN ('BYE', 'MIRAE')
      AND processed."event_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'BYE/MIRAE settlement is still pending; drain settlement before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "matching"."closed_order_markers" AS marker
    JOIN "order"."orders" AS orders ON orders."id" = marker."order_id"
    WHERE orders."symbol" IN ('BYE', 'MIRAE')
      AND orders."status" IN ('OPEN', 'PARTIAL')
  ) THEN
    RAISE EXCEPTION 'BYE/MIRAE close is still pending; drain settlement before applying this migration';
  END IF;
END $$;

WITH releases AS (
  SELECT
    "account_id",
    SUM(("qty" - "filled_qty")::BIGINT * "hold_per_unit") AS amount
  FROM "order"."orders"
  WHERE "symbol" IN ('BYE', 'MIRAE')
    AND "side" = 'BUY'
    AND "status" IN ('OPEN', 'PARTIAL')
  GROUP BY "account_id"
)
UPDATE "account"."accounts" AS accounts
SET
  "hold_amount" = GREATEST(0::BIGINT, accounts."hold_amount" - releases.amount),
  "version" = accounts."version" + 1
FROM releases
WHERE accounts."id" = releases."account_id";

WITH releases AS (
  SELECT
    "account_id",
    "symbol",
    SUM("qty" - "filled_qty")::INT AS qty
  FROM "order"."orders"
  WHERE "symbol" IN ('BYE', 'MIRAE')
    AND "side" = 'SELL'
    AND "status" IN ('OPEN', 'PARTIAL')
  GROUP BY "account_id", "symbol"
)
UPDATE "account"."holdings" AS holdings
SET
  "hold_qty" = GREATEST(0, holdings."hold_qty" - releases.qty),
  "version" = holdings."version" + 1
FROM releases
WHERE holdings."account_id" = releases."account_id"
  AND holdings."symbol" = releases."symbol";

UPDATE "order"."orders"
SET
  "status" = 'CANCELED',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "symbol" IN ('BYE', 'MIRAE')
  AND "status" IN ('OPEN', 'PARTIAL');

-- An unpublished pre-delist placement must not recreate a removed book on a
-- later relay retry. Published historical outbox rows remain as audit data.
DELETE FROM "order"."outbox"
WHERE "published_at" IS NULL
  AND "payload" ->> 'symbol' IN ('BYE', 'MIRAE');

DELETE FROM "market"."candles"
WHERE "symbol" IN ('BYE', 'MIRAE');

DELETE FROM "market"."symbols"
WHERE "symbol" IN ('BYE', 'MIRAE');
