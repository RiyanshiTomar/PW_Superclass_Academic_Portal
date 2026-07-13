-- ============================================================
-- Superclass Portal — Test Scheduler (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor after migration-concept-tags.sql.
--
-- Batch-wise tests with stages (Draft → Faculty Assigned → Confirmed / Rework),
-- validated against the batch's class planner, the room and the faculty so
-- nothing overlaps. Part tests attach the chapters they cover (test_chapters).
-- ============================================================

CREATE TABLE IF NOT EXISTS test_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,   -- NULL for a Full-syllabus test
  classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
  faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL,  -- invigilator / owning faculty
  name TEXT NOT NULL DEFAULT '',
  test_date DATE NOT NULL,
  start_time TIME NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  test_type TEXT NOT NULL DEFAULT 'Objective',   -- Objective | Subjective
  part_type TEXT NOT NULL DEFAULT 'Full',        -- Full | Part
  stage TEXT NOT NULL DEFAULT 'Draft',           -- Draft, Faculty Assigned, Confirmed, Rework
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_test_schedules_batch ON test_schedules(batch_id);
CREATE INDEX IF NOT EXISTS idx_test_schedules_date ON test_schedules(test_date);
CREATE INDEX IF NOT EXISTS idx_test_schedules_faculty ON test_schedules(faculty_id);
CREATE INDEX IF NOT EXISTS idx_test_schedules_room ON test_schedules(classroom_id);

-- Chapters covered by a (Part) test. Full tests leave this empty = whole syllabus.
CREATE TABLE IF NOT EXISTS test_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES test_schedules(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  UNIQUE(test_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_test_chapters_test ON test_chapters(test_id);

-- Reschedule requests already exist for planners; let them carry a test too.
ALTER TABLE reschedule_requests ADD COLUMN IF NOT EXISTS test_id UUID REFERENCES test_schedules(id) ON DELETE CASCADE;

-- ------------------------------------------------------------
-- RLS — DISABLED to match planners/batches (app-level role checks).
-- ------------------------------------------------------------
ALTER TABLE test_schedules DISABLE ROW LEVEL SECURITY;
ALTER TABLE test_chapters  DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read test_schedules" ON test_schedules;
DROP POLICY IF EXISTS "Authenticated write test_schedules" ON test_schedules;
CREATE POLICY "Authenticated read test_schedules" ON test_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write test_schedules" ON test_schedules FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read test_chapters" ON test_chapters;
DROP POLICY IF EXISTS "Authenticated write test_chapters" ON test_chapters;
CREATE POLICY "Authenticated read test_chapters" ON test_chapters FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write test_chapters" ON test_chapters FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New tables: test_schedules, test_chapters. reschedule_requests gains test_id.
-- ============================================================
