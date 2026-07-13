-- ============================================================
-- Superclass Portal — Test Results (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor after migration-test-scheduler.sql.
--
-- Per-student marks for a test. Objective marks are entered by the batch
-- manager; subjective marks come via CSV (or later, an API). The student
-- roster is derived from the attendance sheet via the batch mapping.
-- ============================================================

-- Marks config lives on the test itself (set once when entering results).
ALTER TABLE test_schedules ADD COLUMN IF NOT EXISTS max_marks INTEGER;
ALTER TABLE test_schedules ADD COLUMN IF NOT EXISTS pass_marks INTEGER;

CREATE TABLE IF NOT EXISTS test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES test_schedules(id) ON DELETE CASCADE,
  regno TEXT NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  marks NUMERIC,                       -- NULL = not entered
  absent BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'objective',  -- objective | subjective
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(test_id, regno)
);

CREATE INDEX IF NOT EXISTS idx_test_results_test ON test_results(test_id);

-- Distinct student roster for a sheet batch (from attendance). SECURITY INVOKER
-- so attendance RLS still applies (admin/central/branch/batch_manager only) —
-- used on the marks-entry side; the view side reads names from test_results.
CREATE OR REPLACE FUNCTION attendance_roster(p_batch_name TEXT)
RETURNS TABLE(regno TEXT, student_name TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (a.regno) a.regno, a.student_name
  FROM attendance a
  WHERE a.batch_name = p_batch_name
  ORDER BY a.regno, a.student_name;
$$;

-- ------------------------------------------------------------
-- RLS — DISABLED to match planners/tests (app-level role checks).
-- ------------------------------------------------------------
ALTER TABLE test_results DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read test_results" ON test_results;
DROP POLICY IF EXISTS "Authenticated write test_results" ON test_results;
CREATE POLICY "Authenticated read test_results" ON test_results FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write test_results" ON test_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New table: test_results. test_schedules gains max_marks, pass_marks.
-- New RPC: attendance_roster(text).
-- ============================================================
