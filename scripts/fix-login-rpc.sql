-- ============================================================
-- FIX: login callback failing with "not_registered" for everyone.
-- Cause: the OUT parameter `centre_id` clashed with app_users.centre_id,
-- making the SELECT ambiguous → the function errored on every login.
-- Fix: alias the table and qualify every column (u.centre_id, etc.).
-- Run once in Supabase SQL Editor. Takes effect immediately (no redeploy).
-- ============================================================
CREATE OR REPLACE FUNCTION link_auth_and_get_role(user_email TEXT, user_auth_id UUID)
RETURNS TABLE(user_role TEXT, user_roles TEXT[], user_status TEXT, centre_id UUID) AS $$
DECLARE
  found_user RECORD;
BEGIN
  SELECT u.id, u.role, u.roles, u.status, u.centre_id
    INTO found_user
    FROM app_users u
   WHERE u.email = lower(user_email)
   LIMIT 1;

  IF found_user.id IS NOT NULL THEN
    UPDATE app_users
       SET auth_id = user_auth_id
     WHERE id = found_user.id AND auth_id IS NULL;

    RETURN QUERY SELECT found_user.role, found_user.roles, found_user.status, found_user.centre_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
