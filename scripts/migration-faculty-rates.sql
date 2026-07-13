-- ============================================================
-- Superclass Portal — Faculty Cost / Rates (ADDITIVE, idempotent).
-- Run in the Supabase SQL Editor.
--
-- Time-versioned pay rate per faculty. To change a rate, add a NEW row with a
-- new effective_from — old hours stay costed at the old rate. The rate that
-- applies on any date = the row with the greatest effective_from <= that date.
--   rate_type: 'hourly' (₹/hour, for Hourly/Contract) | 'fixed' (lump sum,
--   for Permanent). Payroll calc & Permanent-vs-Hourly comparison come later.
-- ============================================================

CREATE TABLE IF NOT EXISTS faculty_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  rate_type TEXT NOT NULL DEFAULT 'hourly',   -- hourly | fixed
  amount NUMERIC NOT NULL,
  effective_from DATE NOT NULL,
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_faculty_rates_faculty ON faculty_rates(faculty_id, effective_from DESC);

-- RLS DISABLED to match app tables (admin-only writes enforced in the app).
ALTER TABLE faculty_rates DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read faculty_rates" ON faculty_rates;
DROP POLICY IF EXISTS "Authenticated write faculty_rates" ON faculty_rates;
CREATE POLICY "Authenticated read faculty_rates" ON faculty_rates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write faculty_rates" ON faculty_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- DONE. New table: faculty_rates.
-- ============================================================
