-- 체결 후 자동 보호: 손절만 또는 익절만도 걸 수 있게 한다. 둘 중 하나는 있어야 한다.
ALTER TABLE "order"."bracket_intents" ALTER COLUMN "stop_bps" DROP NOT NULL;
ALTER TABLE "order"."bracket_intents" ALTER COLUMN "take_bps" DROP NOT NULL;
ALTER TABLE "order"."bracket_intents"
  ADD CONSTRAINT "bracket_intents_one_leg_check" CHECK ("stop_bps" IS NOT NULL OR "take_bps" IS NOT NULL);
