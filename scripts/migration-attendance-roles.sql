-- ============================================================
-- Attendance visibility for Branch Head + Batch Manager (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor after scripts/migration-attendance.sql.
--
-- Central Team + Admin already had read access. This extends READ to
-- branch_head and batch_manager (app scopes WHICH batches each one sees).
-- Only admin/central may WRITE the batch↔sheet mapping (unchanged).
-- ============================================================

DROP POLICY IF EXISTS "att read admin/central" ON attendance;
DROP POLICY IF EXISTS "att read staff" ON attendance;
CREATE POLICY "att read staff" ON attendance FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid()
    AND a.roles && ARRAY['admin','central_team','branch_head','batch_manager']));

DROP POLICY IF EXISTS "map read admin/central" ON batch_attendance_map;
DROP POLICY IF EXISTS "map read staff" ON batch_attendance_map;
CREATE POLICY "map read staff" ON batch_attendance_map FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid()
    AND a.roles && ARRAY['admin','central_team','branch_head','batch_manager']));

-- Write (create/update the mapping) stays with admin + central team only.
DROP POLICY IF EXISTS "map write admin/central" ON batch_attendance_map;
CREATE POLICY "map write admin/central" ON batch_attendance_map FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']))
  WITH CHECK (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND a.roles && ARRAY['admin','central_team']));

-- DONE.
