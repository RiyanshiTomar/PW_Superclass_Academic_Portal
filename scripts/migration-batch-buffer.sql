-- ============================================================
-- Batch buffer / lateness tracking.
-- `buffer_days` is a cushion after the planned end_date: reschedules and
-- test-priority shifts can push lectures later, and a batch is only flagged
-- "late" once its last lecture runs past end_date + buffer_days. The actual
-- delay is computed live from MAX(batch_planners.planned_date), so nothing
-- drifts. Idempotent.
-- ============================================================

ALTER TABLE batches ADD COLUMN IF NOT EXISTS buffer_days INTEGER NOT NULL DEFAULT 0;
