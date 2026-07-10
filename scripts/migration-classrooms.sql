-- ============================================================
-- Superclass Portal — Classrooms / Halls Migration (ADDITIVE, non-destructive)
-- Run this in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Adds physical rooms ("halls") that belong to a centre, and a
-- classroom_id on both the recurring weekly timetable (batch_schedules)
-- and the materialised dated lectures (batch_planners) so the app can
-- guarantee: one room can only host one class at any given time.
-- Existing tables & data are untouched.
-- ============================================================

-- 1. CLASSROOMS — a physical hall in a centre. One centre has many rooms.
CREATE TABLE IF NOT EXISTS classrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id UUID NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  room_no TEXT,               -- e.g. CR1 / 101 / 1 (as used physically at the centre)
  name TEXT NOT NULL,         -- e.g. Study Space / Skill Zone
  capacity INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(centre_id, name)
);
CREATE INDEX IF NOT EXISTS idx_classrooms_centre ON classrooms(centre_id);
-- If the table already existed from an earlier run, make sure the column is present.
ALTER TABLE classrooms ADD COLUMN IF NOT EXISTS room_no TEXT;

-- 2. Recurring weekly timetable gains a room.
--    ON DELETE SET NULL: deactivate rooms rather than hard-delete; if a room
--    is ever deleted the schedule survives (just loses its room reference).
ALTER TABLE batch_schedules ADD COLUMN IF NOT EXISTS classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batch_schedules_classroom_day ON batch_schedules(classroom_id, day_of_week);

-- 3. Materialised dated lectures gain a room (inherited from the batch's
--    weekly timetable for that subject when a planner is assigned).
ALTER TABLE batch_planners ADD COLUMN IF NOT EXISTS classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batch_planners_classroom_date ON batch_planners(classroom_id, planned_date);

-- ------------------------------------------------------------
-- Row Level Security — keep DISABLED to match every existing table
-- (app-level role checks are enforced in code / proxy.ts).
-- ------------------------------------------------------------
ALTER TABLE classrooms DISABLE ROW LEVEL SECURITY;

-- Parity policies (inert while RLS is disabled; kept for future parity).
DROP POLICY IF EXISTS "Authenticated read classrooms" ON classrooms;
DROP POLICY IF EXISTS "Authenticated write classrooms" ON classrooms;
CREATE POLICY "Authenticated read classrooms" ON classrooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write classrooms" ON classrooms FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New table: classrooms. batch_schedules & batch_planners gain classroom_id.
-- ============================================================
