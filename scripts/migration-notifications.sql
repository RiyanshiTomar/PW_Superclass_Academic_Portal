-- ============================================================
-- Superclass Portal — Notifications (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor.
--
-- Per-user in-app alerts: planner/test assigned → faculty; reschedule request
-- → central; approval/rejection → the requester; confirmation → central. Shown
-- in the sidebar bell. `link` is where clicking the notification takes you.
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',   -- info | planner | test | reschedule | result
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

-- RLS DISABLED to match app tables (the UI queries user_id = me).
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read notifications" ON notifications;
DROP POLICY IF EXISTS "Authenticated write notifications" ON notifications;
CREATE POLICY "Authenticated read notifications" ON notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write notifications" ON notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New table: notifications.
-- ============================================================
