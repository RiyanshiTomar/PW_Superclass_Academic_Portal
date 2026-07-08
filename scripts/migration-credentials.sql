-- ============================================================
-- Email + password login: a locked "credentials" mirror so admins can see
-- everyone's password. RLS ON: only admins read all; each user reads/updates
-- their own row; the public/anon key sees NOTHING. Service role (seed script)
-- bypasses RLS to fill it.
-- Run once in Supabase SQL Editor.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id        UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  password_plain TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;

-- Admins: full access to every credential row.
DROP POLICY IF EXISTS "admin all credentials" ON user_credentials;
CREATE POLICY "admin all credentials" ON user_credentials FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND 'admin' = ANY(a.roles)))
  WITH CHECK (EXISTS (SELECT 1 FROM app_users a WHERE a.auth_id = auth.uid() AND 'admin' = ANY(a.roles)));

-- Each user: read + update ONLY their own credential (for self password change sync).
DROP POLICY IF EXISTS "self read credential" ON user_credentials;
CREATE POLICY "self read credential" ON user_credentials FOR SELECT TO authenticated
  USING (user_id = (SELECT a.id FROM app_users a WHERE a.auth_id = auth.uid()));

DROP POLICY IF EXISTS "self update credential" ON user_credentials;
CREATE POLICY "self update credential" ON user_credentials FOR UPDATE TO authenticated
  USING      (user_id = (SELECT a.id FROM app_users a WHERE a.auth_id = auth.uid()))
  WITH CHECK (user_id = (SELECT a.id FROM app_users a WHERE a.auth_id = auth.uid()));

-- DONE. Now run:  node scripts/seed-passwords.js   (creates passwords + fills this table)
