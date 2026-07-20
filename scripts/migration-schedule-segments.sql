-- Date-range segments for the weekly batch schedule.
-- A schedule slot (subject + faculty + room + weekday + time) can now apply to
-- only a SUB-RANGE of the batch, so the weekly pattern can change over the
-- batch's life (e.g. Mon/Tue/Wed for 20 Jul–01 Aug, then Thu/Wed/Fri after).
--
-- NULL = "the whole batch" (start_date → end_date) — fully backward compatible
-- with every schedule that existed before this migration.

ALTER TABLE batch_schedules ADD COLUMN IF NOT EXISTS effective_from DATE;
ALTER TABLE batch_schedules ADD COLUMN IF NOT EXISTS effective_to   DATE;

-- Speeds up the (batch, subject, weekday) lookups the planner engine does.
CREATE INDEX IF NOT EXISTS idx_batch_schedules_batch_subject_day
  ON batch_schedules (batch_id, subject_id, day_of_week);
