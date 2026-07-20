-- ============================================================
-- Buffer lectures live INSIDE the planner (start_date → end_date), not as a
-- separate batches.buffer_days cushion. A buffer lecture is a reserved empty
-- slot (no chapter/topic) that reschedules / tests / events shift real content
-- into, so the plan slides forward without crossing the batch's end date.
--
-- `is_buffer = true`  → reserved slot, NOT a conducted class (never counted for
--                       pricing / attendance until it becomes real).
-- `is_buffer = false` → a real planned/conducted lecture (counts).
--
-- Pricing later will count conducted lectures WHERE is_buffer = false.
-- Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE planner_lectures ADD COLUMN IF NOT EXISTS is_buffer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_planners  ADD COLUMN IF NOT EXISTS is_buffer BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_batch_planners_buffer ON batch_planners(batch_id, is_buffer);
