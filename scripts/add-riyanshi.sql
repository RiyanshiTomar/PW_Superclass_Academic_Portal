-- ============================================================
-- Register riyanshi.tomar@pw.live with ALL roles.
-- Run in Supabase SQL Editor. Each statement is independent, so the
-- user gets created even if the centre step does nothing.
-- ============================================================

-- 1) Insert (or update) the user — does NOT depend on any centre.
INSERT INTO app_users (full_name, email, role, roles, status)
VALUES (
  'Riyanshi Tomar',
  'riyanshi.tomar@pw.live',
  'central_team',
  ARRAY['admin', 'central_team', 'faculty', 'branch_head', 'batch_manager'],
  'active'
)
ON CONFLICT (email) DO UPDATE
  SET roles  = ARRAY['admin', 'central_team', 'faculty', 'branch_head', 'batch_manager'],
      status = 'active';

-- 2) Attach to the first active centre (skips silently if no centre / already linked).
INSERT INTO user_centres (user_id, centre_id, is_primary)
SELECT u.id, c.id, true
FROM app_users u
CROSS JOIN LATERAL (SELECT id FROM centres WHERE is_active ORDER BY name LIMIT 1) c
WHERE u.email = 'riyanshi.tomar@pw.live'
ON CONFLICT (user_id, centre_id) DO NOTHING;

-- 3) Verify — this MUST return exactly one row with status = active.
SELECT email, role, roles, status FROM app_users WHERE email = 'riyanshi.tomar@pw.live';
