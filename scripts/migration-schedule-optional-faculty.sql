-- ============================================================
-- Make faculty optional on the weekly batch schedule AND on the
-- materialised planner lectures. Central can lay out a batch's
-- timetable and its dated lecture plan (subject + room + timing +
-- topic) even when a teacher isn't decided yet or is on leave, and
-- assign the faculty later. Room + timing stay required at the app
-- layer. Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE batch_schedules ALTER COLUMN faculty_id DROP NOT NULL;

-- Concrete (materialised) planner lectures — same TBD flexibility.
ALTER TABLE batch_planners ALTER COLUMN faculty_id DROP NOT NULL;
-- planner_lectures.faculty_id is already nullable (created that way).
