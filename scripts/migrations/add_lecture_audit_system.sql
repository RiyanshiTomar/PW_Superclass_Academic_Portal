-- Migration: Add Daily Lecture Audit System
-- Run once in Supabase SQL Editor
-- Uses actual batch_planners schema: chapter (text), topic_name — no chapter_id

-- Step 1: Create lecture_audits table
CREATE TABLE IF NOT EXISTS lecture_audits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_planner_id  UUID NOT NULL REFERENCES batch_planners(id) ON DELETE CASCADE,
  batch_id          UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  centre_id         UUID NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  subject_id        UUID REFERENCES subjects(id) ON DELETE SET NULL,
  faculty_id        UUID REFERENCES app_users(id) ON DELETE SET NULL,

  lecture_date      DATE NOT NULL,
  planned_topic     TEXT,
  start_time        TIME,
  duration_minutes  INTEGER,

  lecture_link      TEXT,
  audited_by        UUID REFERENCES app_users(id) ON DELETE SET NULL,
  audited_at        TIMESTAMPTZ,

  topic_check       BOOLEAN DEFAULT FALSE,
  duration_check    BOOLEAN DEFAULT FALSE,
  ppt_check         BOOLEAN DEFAULT FALSE,

  remarks           TEXT,
  audit_status      TEXT DEFAULT 'pending' CHECK (audit_status IN ('pending', 'audited', 'flagged')),

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(batch_planner_id)
);

-- Step 2: Indexes
CREATE INDEX IF NOT EXISTS idx_lecture_audits_batch_id     ON lecture_audits(batch_id);
CREATE INDEX IF NOT EXISTS idx_lecture_audits_centre_id    ON lecture_audits(centre_id);
CREATE INDEX IF NOT EXISTS idx_lecture_audits_lecture_date ON lecture_audits(lecture_date);
CREATE INDEX IF NOT EXISTS idx_lecture_audits_audit_status ON lecture_audits(audit_status);

-- Step 3: updated_at trigger
CREATE OR REPLACE FUNCTION update_lecture_audit_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lecture_audits_updated_at ON lecture_audits;
CREATE TRIGGER trg_lecture_audits_updated_at
  BEFORE UPDATE ON lecture_audits
  FOR EACH ROW EXECUTE FUNCTION update_lecture_audit_timestamp();

-- Step 4: get_central_team_members (central team owner dropdown in BatchScheduler)
CREATE OR REPLACE FUNCTION get_central_team_members()
RETURNS TABLE(id UUID, full_name TEXT, email TEXT, role TEXT, roles TEXT[], centre_id UUID) AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.full_name, u.email, u.role, u.roles, u.centre_id
    FROM app_users u
    WHERE u.status = 'active'
      AND (u.role IN ('central_team', 'admin') OR u.roles @> ARRAY['central_team'] OR u.roles @> ARRAY['admin'])
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_central_team_members TO authenticated;

COMMENT ON TABLE lecture_audits IS 'Daily lecture audit — central team verifies lectures date-wise from batch planner';
