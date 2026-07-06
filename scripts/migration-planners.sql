-- ============================================================
-- Superclass Portal — Planner Entity Migration (ADDITIVE, non-destructive)
-- Run this in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Adds a first-class "Planner" that is created once (from a CSV),
-- can be linked to MANY batches (and a batch to many planners),
-- and moves through stages. Existing tables & data are untouched.
-- The existing `batch_planners` table is reused as the materialised
-- (concrete, per-batch/per-faculty) lecture table.
-- ============================================================

-- 1. PLANNERS — batch-agnostic template. Carries a default (intended) faculty
--    so faculty info travels with the planner and pre-fills at assignment.
CREATE TABLE IF NOT EXISTS planners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  default_faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- If the table already existed from an earlier run, make sure the column is present.
ALTER TABLE planners ADD COLUMN IF NOT EXISTS default_faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL;

-- 2. PLANNER_LECTURES — the ordered lecture rows of a planner (from the CSV).
--    Each lecture carries its OWN faculty (a planner can span many teachers).
CREATE TABLE IF NOT EXISTS planner_lectures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id UUID NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  chapter TEXT NOT NULL DEFAULT '',
  topic_name TEXT NOT NULL DEFAULT '',
  faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  planned_date DATE NOT NULL,
  start_time TIME,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planner_lectures_planner ON planner_lectures(planner_id);
-- If planner_lectures already existed from an earlier run, add the per-lecture faculty column.
ALTER TABLE planner_lectures ADD COLUMN IF NOT EXISTS faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL;

-- 3. BATCH_PLANNER_LINKS — M:N junction + lifecycle stage. Faculty lives on the
--    lectures (per-lecture), so the link's faculty is nullable / unused.
CREATE TABLE IF NOT EXISTS batch_planner_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id UUID NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  faculty_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'Draft', -- Draft, Faculty Assigned, Confirmed, Rework
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(planner_id, batch_id)
);
-- If the link table already existed with a NOT NULL faculty, relax it.
ALTER TABLE batch_planner_links ALTER COLUMN faculty_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_batch_planner_links_batch ON batch_planner_links(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_planner_links_faculty ON batch_planner_links(faculty_id);
CREATE INDEX IF NOT EXISTS idx_batch_planner_links_planner ON batch_planner_links(planner_id);

-- 4. Extend batch_planners: materialised rows point back at their link + template row.
--    Existing/manual rows keep NULL for both columns.
ALTER TABLE batch_planners ADD COLUMN IF NOT EXISTS link_id UUID REFERENCES batch_planner_links(id) ON DELETE CASCADE;
ALTER TABLE batch_planners ADD COLUMN IF NOT EXISTS planner_lecture_id UUID REFERENCES planner_lectures(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batch_planners_link ON batch_planners(link_id);

-- ------------------------------------------------------------
-- Row Level Security — keep DISABLED to match every existing table
-- (app-level role checks are enforced in code / proxy.ts).
-- ------------------------------------------------------------
ALTER TABLE planners DISABLE ROW LEVEL SECURITY;
ALTER TABLE planner_lectures DISABLE ROW LEVEL SECURITY;
ALTER TABLE batch_planner_links DISABLE ROW LEVEL SECURITY;

-- Parity policies (inert while RLS is disabled; kept for future parity).
DROP POLICY IF EXISTS "Authenticated read planners" ON planners;
DROP POLICY IF EXISTS "Authenticated write planners" ON planners;
DROP POLICY IF EXISTS "Authenticated read planner_lectures" ON planner_lectures;
DROP POLICY IF EXISTS "Authenticated write planner_lectures" ON planner_lectures;
DROP POLICY IF EXISTS "Authenticated read batch_planner_links" ON batch_planner_links;
DROP POLICY IF EXISTS "Authenticated write batch_planner_links" ON batch_planner_links;
CREATE POLICY "Authenticated read planners" ON planners FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write planners" ON planners FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read planner_lectures" ON planner_lectures FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write planner_lectures" ON planner_lectures FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read batch_planner_links" ON batch_planner_links FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write batch_planner_links" ON batch_planner_links FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New tables: planners, planner_lectures, batch_planner_links.
-- batch_planners gains link_id + planner_lecture_id.
-- ============================================================
