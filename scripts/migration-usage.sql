-- ============================================================
-- Superclass Portal — Usage & Login tracking (ADDITIVE, non-destructive)
-- Run in the Supabase SQL Editor. Safe to re-run (idempotent).
--
--   login_events  -- one row per sign-in with email + password
--   usage_daily   -- one row per user, per day (IST), per portal page, with
--                    a hit count — small enough for the free plan, detailed
--                    enough to show who uses which part of the portal.
--
-- Existing tables & data are untouched.
-- ============================================================

CREATE TABLE IF NOT EXISTS login_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_events_at ON login_events(at);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, at);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id   UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  day       DATE NOT NULL,                 -- India date
  section   TEXT NOT NULL,                 -- page, ids replaced: '/central/batches/:id'
  portal    TEXT,                          -- 'central', 'faculty', 'admin', ...
  hits      INTEGER NOT NULL DEFAULT 0,
  first_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, section)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

-- One page view: add 1 to today's row (creates it on the first view).
CREATE OR REPLACE FUNCTION track_usage(p_user UUID, p_day DATE, p_section TEXT, p_portal TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO usage_daily (user_id, day, section, portal, hits)
  VALUES (p_user, p_day, p_section, p_portal, 1)
  ON CONFLICT (user_id, day, section)
  DO UPDATE SET hits = usage_daily.hits + 1, last_at = now();
$$;
