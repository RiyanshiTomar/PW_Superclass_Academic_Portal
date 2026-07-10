-- ============================================================
-- Attendance (read-only, fed from the biometric Google Sheet via sync).
-- Admin + Central Team can read; only the sync (service role) writes.
-- Run once in Supabase SQL Editor.
-- ============================================================

-- Raw attendance rows mirrored from the sheet.
CREATE TABLE IF NOT EXISTS attendance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regno            TEXT NOT NULL,
  student_name     TEXT NOT NULL DEFAULT '',
  mobile_no        TEXT,
  center           TEXT,
  scheme           TEXT,
  course           TEXT,
  admission_status TEXT,
  sheet_batch_id   TEXT,            -- batch_id column from the sheet
  batch_name       TEXT,            -- batch column from the sheet
  attendance_date  DATE NOT NULL,
  first_punch_in   TEXT,            -- stored raw (formats vary); parsed in app
  last_punch_out   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (regno, attendance_date, batch_name)
);
CREATE INDEX IF NOT EXISTS idx_attendance_batch ON attendance(batch_name);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);

-- Links a portal batch (scheduler) to the sheet's batch, so we know which
-- days actually have class (Sundays/holidays excluded from %).
CREATE TABLE IF NOT EXISTS batch_attendance_map (
  portal_batch_id UUID PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  sheet_batch_id  TEXT,
  batch_name      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- RLS: only admin / central_team may read; central/admin may set the map ----
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_attendance_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "att read admin/central" ON attendance;
CREATE POLICY "att read admin/central" ON attendance FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']));

DROP POLICY IF EXISTS "map read admin/central" ON batch_attendance_map;
CREATE POLICY "map read admin/central" ON batch_attendance_map FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']));

DROP POLICY IF EXISTS "map write admin/central" ON batch_attendance_map;
CREATE POLICY "map write admin/central" ON batch_attendance_map FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']))
  WITH CHECK (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']));

-- DONE. Now set up the service account + run:  npm run sync-attendance
