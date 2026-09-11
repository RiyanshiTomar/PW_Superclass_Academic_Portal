-- ============================================================
-- Add Batch Progress Reviewers
-- Role: progress_reviewer — dedicated portal at /progress-reviewer
-- Can view batch progress across ALL centres, read-only.
-- No access to scheduling, tests, marks, or any other portal.
--
-- Run in Supabase SQL Editor. Safe / idempotent (ON CONFLICT).
--
-- After running this SQL, set passwords locally:
--   node scripts/set-password.js sudarshan.mishra@pw.live "Superclass@1234"
--   node scripts/set-password.js vasu.gulati@pw.live "Superclass@1234"
-- (change the password to whatever you want)
-- ============================================================

INSERT INTO app_users (full_name, email, role, roles, status)
VALUES
  ('Sudarshan Mishra', 'sudarshan.mishra@pw.live', 'progress_reviewer', ARRAY['progress_reviewer'], 'active'),
  ('Vasu Gulati',      'vasu.gulati@pw.live',      'progress_reviewer', ARRAY['progress_reviewer'], 'active')
ON CONFLICT (email) DO UPDATE
  SET role   = 'progress_reviewer',
      roles  = ARRAY['progress_reviewer'],
      status = 'active';

-- Verify — must return 2 rows, status = active, role = progress_reviewer
SELECT email, role, roles, status
FROM app_users
WHERE email IN ('sudarshan.mishra@pw.live', 'vasu.gulati@pw.live');
