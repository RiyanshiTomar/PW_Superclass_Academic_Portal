-- ============================================================
-- Grant a person access to ALL portals (admin, central_team, faculty,
-- branch_head, batch_manager). No centre link.
-- Reusable: change the name/email below to add anyone.
-- Run in Supabase SQL Editor. Safe / idempotent (insert-or-update).
-- ============================================================

-- Insert (or update) the user with all roles, active.
INSERT INTO app_users (full_name, email, role, roles, status)
VALUES (
  'Gaurav Burman',                 -- 👈 full name
  'gaurav.burman@pw.live',         -- 👈 email
  'central_team',
  ARRAY['admin', 'central_team', 'faculty', 'branch_head', 'batch_manager'],
  'active'
)
ON CONFLICT (email) DO UPDATE
  SET roles  = ARRAY['admin', 'central_team', 'faculty', 'branch_head', 'batch_manager'],
      status = 'active';

-- Verify — must return one row, status = active, all roles.
SELECT email, role, roles, status FROM app_users WHERE email = 'gaurav.burman@pw.live';
