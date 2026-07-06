-- ============================================================
-- TEST HELPER: make riyanshi.tomar@pw.live a faculty too, attached to a centre.
-- Keeps all existing roles (central_team, admin, etc.) — just ADDS 'faculty'.
-- Run once in Supabase SQL Editor. Safe / idempotent.
-- ============================================================
DO $$
DECLARE
  v_centre UUID;
  v_user   UUID;
BEGIN
  SELECT id INTO v_centre FROM centres WHERE is_active ORDER BY name LIMIT 1;
  SELECT id INTO v_user   FROM app_users WHERE email = 'riyanshi.tomar@pw.live';

  IF v_user IS NULL THEN
    RAISE NOTICE 'User riyanshi.tomar@pw.live not found — check the email.';
    RETURN;
  END IF;

  -- Add 'faculty' to the roles array without dropping existing roles.
  UPDATE app_users
     SET roles  = (SELECT ARRAY(SELECT DISTINCT e FROM unnest(coalesce(roles, '{}') || ARRAY['faculty']) e)),
         status = 'active'
   WHERE id = v_user;

  -- Attach to a centre so this account shows up as faculty for that centre.
  INSERT INTO user_centres (user_id, centre_id, is_primary)
  VALUES (v_user, v_centre, false)
  ON CONFLICT (user_id, centre_id) DO NOTHING;
END $$;

-- 👇 Use THIS centre when you create the test batch:
SELECT c.name AS use_this_centre_for_your_batch, c.id
FROM centres c
WHERE c.is_active
ORDER BY c.name
LIMIT 1;
