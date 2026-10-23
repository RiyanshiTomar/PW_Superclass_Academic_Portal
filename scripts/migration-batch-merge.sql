-- ============================================================
-- Superclass Portal — Batch merge date (ADDITIVE, non-destructive)
-- Run in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- A merged-in batch remembers WHICH batch it joined and FROM WHICH DATE, so
-- the portal can say "Merged into CAF Jan 2027 B4 on 01 Nov 2026" and keep
-- its records before that date.
-- ============================================================

ALTER TABLE batches ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS merged_on DATE;
CREATE INDEX IF NOT EXISTS idx_batches_merged_into ON batches(merged_into);
