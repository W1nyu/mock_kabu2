-- OCO (one-cancels-other) grouping for conditional orders.
-- When one row of a group is claimed (WAITING -> TRIGGERED) the API cancels
-- every other WAITING row in the same group in the same step.
ALTER TABLE "order"."conditional_orders" ADD COLUMN "oco_group_id" TEXT;
CREATE INDEX "conditional_orders_oco_group_id_idx" ON "order"."conditional_orders" ("oco_group_id");
