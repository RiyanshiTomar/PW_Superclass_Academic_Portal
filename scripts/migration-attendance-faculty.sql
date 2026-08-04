-- ============================================================
-- Attendance visibility for FACULTY (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor after scripts/migration-attendance-roles.sql.
--
-- Faculty now have an Attendance page (app/faculty/attendance) scoped — at the
-- APP level — to only the batches they teach (batch_schedules.faculty_id).
-- This extends the READ policy on `attendance` to include the faculty role.
-- students / batch_planners / batch_schedules are already authenticated-readable,
-- so no change is needed there. The batch↔sheet WRITE policy is unchanged
-- (admin/central only).
-- ============================================================

DROP POLICY IF EXISTS "att read admin/central" ON attendance;
DROP POLICY IF EXISTS "att read staff" ON attendance;
CREATE POLICY "att read staff" ON attendance FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid()
    AND (a.role = 'faculty' OR a.roles && ARRAY['admin','central_team','branch_head','batch_manager','faculty'])));

-- DONE.
