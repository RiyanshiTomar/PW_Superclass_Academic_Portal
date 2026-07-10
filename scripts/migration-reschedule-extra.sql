-- ============================================================
-- Superclass Portal — Extra-class request fields (ADDITIVE, idempotent)
-- Run in the Supabase SQL Editor. Safe to re-run.
--
-- Lets a faculty's "extra class" request carry a topic/chapter that can
-- differ from the lecture it was anchored to (e.g. a doubt session on the
-- same chapter). Central approval copies these onto the new lecture.
-- ============================================================

ALTER TABLE reschedule_requests ADD COLUMN IF NOT EXISTS extra_topic TEXT;
ALTER TABLE reschedule_requests ADD COLUMN IF NOT EXISTS extra_chapter TEXT;

-- ============================================================
-- DONE.
-- ============================================================
