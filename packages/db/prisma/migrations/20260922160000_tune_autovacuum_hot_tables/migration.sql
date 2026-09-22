-- High-churn tables: rows are inserted by the thousands per minute and deleted
-- in batches by the retention sweeps. The default autovacuum trigger (20% of
-- the table) lets dead tuples pile up for hours on big tables; vacuum sooner so
-- space is reused instead of the heap growing. No-ops on empty tables.
ALTER TABLE "order"."outbox" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "matching"."outbox_events" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "matching"."processed_order_events" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);
ALTER TABLE "matching"."closed_order_markers" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);
ALTER TABLE "account"."processed_events" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);
ALTER TABLE "order"."orders" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "matching"."trades" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "account"."ledger_entries" SET (autovacuum_vacuum_scale_factor = 0.05);
