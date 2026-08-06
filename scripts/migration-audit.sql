-- ============================================================
-- Superclass Portal — CCTV Audit Ingest Migration (ADDITIVE, non-destructive)
-- Run in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Stores results pushed by the CCTV audit fleet so the portal can show,
-- per centre / classroom / day, what the cameras actually observed and
-- line it up against each batch's planner (batch_planners) by
-- classroom_id + time window.
--
--   audit_sessions  -- one row per audit run (a centre, a day)
--   audit_checks    -- one row per camera per check (timestamped) -- this
--                      per-check granularity is what lets us answer
--                      "was the 10:00 Physics class actually held, and how
--                      many students were present" against the planner.
--
-- Existing tables & data are untouched.
-- ============================================================

-- 1. AUDIT_SESSIONS ------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id   UUID REFERENCES centres(id) ON DELETE CASCADE,
  branch_id   TEXT NOT NULL,               -- fleet branch_id (e.g. 'patna')
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  params      JSONB NOT NULL DEFAULT '{}',  -- duration/interval/model/llm etc.
  source      TEXT NOT NULL DEFAULT 'cctv-audit',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, started_at)            -- re-pushing the same run upserts
);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_centre ON audit_sessions(centre_id, started_at);

-- 2. AUDIT_CHECKS --------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_checks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  centre_id      UUID REFERENCES centres(id) ON DELETE CASCADE,        -- denormalised for fast queries
  classroom_id   UUID REFERENCES classrooms(id) ON DELETE SET NULL,    -- matched from camera room_no; null if unmapped
  camera_label   TEXT NOT NULL,
  camera_type    TEXT,
  checked_at     TIMESTAMPTZ NOT NULL,
  student_count  INTEGER,
  person_count   INTEGER,
  teacher_present   BOOLEAN,
  teacher_teaching  BOOLEAN,
  room_empty     BOOLEAN,
  activity_level TEXT,
  flagged        BOOLEAN,
  -- optional LLM "second opinion" columns (null when --llm was off)
  llm_student_count  INTEGER,
  llm_teacher_present BOOLEAN,
  llm_agreement  TEXT,
  llm_notes      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_checks_session   ON audit_checks(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_checks_classroom ON audit_checks(classroom_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_audit_checks_centre    ON audit_checks(centre_id, checked_at);

-- ------------------------------------------------------------
-- Row Level Security — keep DISABLED to match every existing table
-- (app-level role checks are enforced in code / proxy.ts). Ingest happens
-- via the service-role key, which bypasses RLS anyway.
-- ------------------------------------------------------------
ALTER TABLE audit_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checks   DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read audit_sessions" ON audit_sessions;
DROP POLICY IF EXISTS "Authenticated read audit_checks"   ON audit_checks;
CREATE POLICY "Authenticated read audit_sessions" ON audit_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read audit_checks"   ON audit_checks   FOR SELECT TO authenticated USING (true);

-- ============================================================
-- DONE. New tables: audit_sessions, audit_checks.
-- Next: create classrooms per centre (migration-classrooms.sql) and give
-- each audit camera a matching room_no so checks link to a classroom, then
-- join audit_checks × batch_planners on (classroom_id, planned_date, time).
-- ============================================================
