-- ============================================================
-- Superclass Portal — Test cancellation record (ADDITIVE, non-destructive)
-- Run in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- A cancelled test stays in the portal (stage = 'Cancelled') with why, when
-- and by whom it was cancelled, so Central keeps a centre-wise record.
-- ============================================================

ALTER TABLE test_schedules ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE test_schedules ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE test_schedules ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
