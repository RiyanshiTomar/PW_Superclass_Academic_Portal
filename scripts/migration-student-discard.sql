-- ============================================================
-- Superclass Portal — Discard students who have left (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor BEFORE deploying the matching code.
--
-- A discarded student keeps their batch and all past records (marks,
-- attendance), but drops out of every roster: Marks Entry, Attendance,
-- Results, Student Overview and batch fill counts. Restore any time from
-- Students. The sheet sync never changes this status.
-- ============================================================

ALTER TABLE students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';   -- active | discarded
ALTER TABLE students ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN IF NOT EXISTS discard_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);

-- ============================================================
-- DONE.
-- ============================================================
