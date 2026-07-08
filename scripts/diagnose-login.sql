-- Run in the SAME Supabase project. Paste the whole result back.
SELECT
  (SELECT count(*) FROM app_users)                                              AS total_users,
  EXISTS (SELECT 1 FROM app_users WHERE email = 'riyanshi.tomar@pw.live')       AS riyanshi_exists,
  (SELECT status FROM app_users WHERE email = 'riyanshi.tomar@pw.live')         AS riyanshi_status,
  (SELECT roles::text FROM app_users WHERE email = 'riyanshi.tomar@pw.live')    AS riyanshi_roles,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'link_auth_and_get_role')       AS rpc_exists;
