-- ============================================================
-- Superclass Academic Portal - Full Schema (Fresh Start)
-- Run this in Supabase SQL Editor to create all tables
-- ============================================================

-- Drop existing tables (order matters due to FKs)
-- This covers ALL your existing tables for a clean fresh start
DROP TABLE IF EXISTS reschedule_requests CASCADE;
DROP TABLE IF EXISTS batch_planner_links CASCADE;
DROP TABLE IF EXISTS planner_lectures CASCADE;
DROP TABLE IF EXISTS planner_rows CASCADE;
DROP TABLE IF EXISTS planners CASCADE;
DROP TABLE IF EXISTS batch_schedule CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS batch_planners CASCADE;
DROP TABLE IF EXISTS batch_schedules CASCADE;
DROP TABLE IF EXISTS batches CASCADE;
DROP TABLE IF EXISTS faculty_subjects CASCADE;
DROP TABLE IF EXISTS faculty_centres CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;
DROP TABLE IF EXISTS programs CASCADE;
DROP TABLE IF EXISTS user_centres CASCADE;
DROP TABLE IF EXISTS app_users CASCADE;
DROP TABLE IF EXISTS centres CASCADE;

-- Drop existing functions
DROP FUNCTION IF EXISTS list_active_faculty(uuid);
DROP FUNCTION IF EXISTS lookup_faculty_by_email(text, uuid);
DROP FUNCTION IF EXISTS check_email_registered(text);
DROP FUNCTION IF EXISTS link_auth_and_get_role(text, uuid);

-- ============================================================
-- 1. CENTRES
-- ============================================================
CREATE TABLE centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  branch_head_id UUID, -- FK added after app_users created
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. APP_USERS
-- ============================================================
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id UUID UNIQUE,  -- links to auth.users.id (nullable for pre-seeded users)
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'faculty',  -- primary role
  roles TEXT[] NOT NULL DEFAULT '{}',    -- all roles array
  status TEXT NOT NULL DEFAULT 'active', -- active / inactive
  faculty_type TEXT,                     -- Permanent / Hourly/Contract
  centre_id UUID REFERENCES centres(id) ON DELETE SET NULL,  -- primary centre (for backward compat)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add FK for centres.branch_head_id
ALTER TABLE centres
  ADD CONSTRAINT fk_centres_branch_head
  FOREIGN KEY (branch_head_id) REFERENCES app_users(id) ON DELETE SET NULL;

-- ============================================================
-- 3. USER_CENTRES (junction: user <-> centre, supports multi-centre)
-- ============================================================
CREATE TABLE user_centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  centre_id UUID NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, centre_id)
);

CREATE INDEX idx_user_centres_user ON user_centres(user_id);
CREATE INDEX idx_user_centres_centre ON user_centres(centre_id);

-- ============================================================
-- 4. PROGRAMS
-- ============================================================
CREATE TABLE programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. SUBJECTS
-- ============================================================
CREATE TABLE subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(program_id, name)
);

-- ============================================================
-- 6. FACULTY_SUBJECTS (which faculty teaches which subjects)
-- ============================================================
CREATE TABLE faculty_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  UNIQUE(faculty_id, subject_id)
);

-- ============================================================
-- 7. BATCHES
-- ============================================================
CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  centre_id UUID NOT NULL REFERENCES centres(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  batch_manager_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 8. BATCH_SCHEDULES (recurring weekly timetable)
-- ============================================================
CREATE TABLE batch_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  faculty_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_batch_schedules_faculty_day ON batch_schedules(faculty_id, day_of_week);
CREATE INDEX idx_batch_schedules_batch ON batch_schedules(batch_id);

-- ============================================================
-- 9. BATCH_PLANNERS (individual lecture plans, uploaded via CSV)
-- ============================================================
CREATE TABLE batch_planners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  chapter TEXT NOT NULL DEFAULT '',
  topic_name TEXT NOT NULL DEFAULT '',
  faculty_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  planned_date DATE NOT NULL,
  start_time TIME,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  stage TEXT NOT NULL DEFAULT 'Draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_batch_planners_faculty_date ON batch_planners(faculty_id, planned_date);
CREATE INDEX idx_batch_planners_batch ON batch_planners(batch_id);

-- ============================================================
-- 9b. PLANNERS (first-class planner template — created once via CSV,
--     linked to MANY batches; batch_planners holds the materialised rows)
-- ============================================================
CREATE TABLE planners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  default_faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL, -- intended faculty (pre-fills assignment)
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE planner_lectures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id UUID NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  chapter TEXT NOT NULL DEFAULT '',
  topic_name TEXT NOT NULL DEFAULT '',
  faculty_id UUID REFERENCES app_users(id) ON DELETE SET NULL, -- per-lecture teacher
  planned_date DATE NOT NULL,
  start_time TIME,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_planner_lectures_planner ON planner_lectures(planner_id);

-- M:N junction + lifecycle stage. Faculty lives per-lecture, so link faculty is optional.
CREATE TABLE batch_planner_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id UUID NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  faculty_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'Draft', -- Draft, Faculty Assigned, Confirmed, Rework
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(planner_id, batch_id)
);
CREATE INDEX idx_batch_planner_links_batch ON batch_planner_links(batch_id);
CREATE INDEX idx_batch_planner_links_faculty ON batch_planner_links(faculty_id);
CREATE INDEX idx_batch_planner_links_planner ON batch_planner_links(planner_id);

-- Materialised batch_planners rows point back at their link + template row.
ALTER TABLE batch_planners ADD COLUMN link_id UUID REFERENCES batch_planner_links(id) ON DELETE CASCADE;
ALTER TABLE batch_planners ADD COLUMN planner_lecture_id UUID REFERENCES planner_lectures(id) ON DELETE SET NULL;
CREATE INDEX idx_batch_planners_link ON batch_planners(link_id);

-- ============================================================
-- 10. RESCHEDULE_REQUESTS
-- ============================================================
CREATE TABLE reschedule_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id UUID REFERENCES batch_planners(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES batch_schedules(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL DEFAULT 'planner', -- 'planner' or 'schedule'
  original_date DATE,
  original_start_time TIME,
  original_end_time TIME,
  requested_date DATE,
  requested_start_time TIME,
  requested_end_time TIME,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, reworked
  reviewed_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reschedule_requests_status ON reschedule_requests(status);
CREATE INDEX idx_reschedule_requests_requested_by ON reschedule_requests(requested_by);

-- ============================================================
-- 11. AUDIT_LOG
-- ============================================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);

-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

-- Check if email is registered and active (used by login form)
CREATE OR REPLACE FUNCTION check_email_registered(check_email TEXT)
RETURNS TABLE(is_registered BOOLEAN, is_active BOOLEAN) AS $$
DECLARE
  found_user RECORD;
BEGIN
  SELECT id, status INTO found_user
  FROM app_users
  WHERE email = lower(check_email)
  LIMIT 1;

  IF found_user.id IS NOT NULL THEN
    RETURN QUERY SELECT true, (found_user.status = 'active');
  ELSE
    RETURN QUERY SELECT false, false;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Link auth user to app_user and return role info (used by auth callback)
CREATE OR REPLACE FUNCTION link_auth_and_get_role(user_email TEXT, user_auth_id UUID)
RETURNS TABLE(user_role TEXT, user_roles TEXT[], user_status TEXT, centre_id UUID) AS $$
DECLARE
  found_user RECORD;
BEGIN
  SELECT id, role, roles, status, centre_id INTO found_user
  FROM app_users
  WHERE email = lower(user_email)
  LIMIT 1;

  IF found_user.id IS NOT NULL THEN
    -- Update auth_id if not already set
    UPDATE app_users SET auth_id = user_auth_id WHERE id = found_user.id AND auth_id IS NULL;
    RETURN QUERY SELECT found_user.role, found_user.roles, found_user.status, found_user.centre_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- List active faculty for a centre (using user_centres junction)
CREATE OR REPLACE FUNCTION list_active_faculty(p_centre_id UUID)
RETURNS TABLE(id UUID, full_name TEXT, email TEXT, centre_id UUID) AS $$
BEGIN
  IF p_centre_id IS NULL THEN
    -- Return all faculty with their primary centre (no duplicates)
    RETURN QUERY
      SELECT DISTINCT ON (u.id) u.id, u.full_name, u.email, uc.centre_id
      FROM app_users u
      JOIN user_centres uc ON uc.user_id = u.id
      WHERE u.status = 'active'
        AND ('faculty' = ANY(u.roles) OR u.role = 'faculty')
      ORDER BY u.id, uc.is_primary DESC;
  ELSE
    RETURN QUERY
      SELECT u.id, u.full_name, u.email, uc.centre_id
      FROM app_users u
      JOIN user_centres uc ON uc.user_id = u.id
      WHERE u.status = 'active'
        AND uc.centre_id = p_centre_id
        AND ('faculty' = ANY(u.roles) OR u.role = 'faculty')
      ORDER BY u.full_name;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Lookup faculty by email at a specific centre
CREATE OR REPLACE FUNCTION lookup_faculty_by_email(faculty_email TEXT, p_centre_id UUID)
RETURNS UUID AS $$
DECLARE
  found_id UUID;
BEGIN
  SELECT u.id INTO found_id
  FROM app_users u
  JOIN user_centres uc ON uc.user_id = u.id
  WHERE u.email = lower(faculty_email)
    AND u.status = 'active'
    AND ('faculty' = ANY(u.roles) OR u.role = 'faculty')
    AND uc.centre_id = p_centre_id
  LIMIT 1;

  RETURN found_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE centres DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_centres DISABLE ROW LEVEL SECURITY;
ALTER TABLE programs DISABLE ROW LEVEL SECURITY;
ALTER TABLE subjects DISABLE ROW LEVEL SECURITY;
ALTER TABLE faculty_subjects DISABLE ROW LEVEL SECURITY;
ALTER TABLE batches DISABLE ROW LEVEL SECURITY;
ALTER TABLE batch_schedules DISABLE ROW LEVEL SECURITY;
ALTER TABLE batch_planners DISABLE ROW LEVEL SECURITY;
ALTER TABLE planners DISABLE ROW LEVEL SECURITY;
ALTER TABLE planner_lectures DISABLE ROW LEVEL SECURITY;
ALTER TABLE batch_planner_links DISABLE ROW LEVEL SECURITY;
ALTER TABLE reschedule_requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all reference data
CREATE POLICY "Authenticated read centres" ON centres FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read app_users" ON app_users FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read user_centres" ON user_centres FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read programs" ON programs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read subjects" ON subjects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read faculty_subjects" ON faculty_subjects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read batches" ON batches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read batch_schedules" ON batch_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read batch_planners" ON batch_planners FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read audit_log" ON audit_log FOR SELECT TO authenticated USING (true);

-- Allow authenticated users to mutate (app-level role checks done in code)
CREATE POLICY "Authenticated insert centres" ON centres FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update centres" ON centres FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert app_users" ON app_users FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update app_users" ON app_users FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert user_centres" ON user_centres FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated delete user_centres" ON user_centres FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated insert programs" ON programs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update programs" ON programs FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert subjects" ON subjects FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update subjects" ON subjects FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert faculty_subjects" ON faculty_subjects FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated delete faculty_subjects" ON faculty_subjects FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated insert batches" ON batches FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update batches" ON batches FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated delete batches" ON batches FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated insert batch_schedules" ON batch_schedules FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated delete batch_schedules" ON batch_schedules FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated insert batch_planners" ON batch_planners FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update batch_planners" ON batch_planners FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert audit_log" ON audit_log FOR INSERT TO authenticated WITH CHECK (true);

-- Service role bypasses RLS automatically, so import script works fine

-- ============================================================
-- DONE! Now run: npm run import-data
-- ============================================================
