-- ============================================================
-- Superclass Portal — Students & Batch Assignment (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor.
--
-- Students are synced from the "Student Dump" Google Sheet (regno, name,
-- centre) via `npm run sync-students`. The sync NEVER touches batch_id —
-- that's the Branch Head's call (assign a student to a batch). Results,
-- attendance & test tie to a student only once a batch is assigned.
-- ============================================================

CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regno TEXT NOT NULL UNIQUE,
  student_name TEXT NOT NULL DEFAULT '',
  centre_id UUID REFERENCES centres(id) ON DELETE SET NULL,
  batch_id UUID REFERENCES batches(id) ON DELETE SET NULL,   -- NULL = Unassigned (branch head assigns a PORTAL batch)
  sheet_batch TEXT,                                          -- batch code from the sheet — a hint for the branch head
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_students_centre ON students(centre_id);
CREATE INDEX IF NOT EXISTS idx_students_batch ON students(batch_id);
-- If the table already existed, make sure the hint column is present.
ALTER TABLE students ADD COLUMN IF NOT EXISTS sheet_batch TEXT;

-- RLS DISABLED to match app tables (branch head / central scoped in app).
ALTER TABLE students DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read students" ON students;
DROP POLICY IF EXISTS "Authenticated write students" ON students;
CREATE POLICY "Authenticated read students" ON students FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write students" ON students FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New table: students. Then run: npm run sync-students
-- ============================================================
