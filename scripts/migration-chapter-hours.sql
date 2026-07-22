-- Per-chapter hours on the concept tags (admin fills these manually).
--   total_hours    → total hours the chapter is worth
--   teaching_hours → hours actually spent teaching it
-- Nullable; used for planning/pacing reference. Additive & safe.
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS total_hours    NUMERIC;
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS teaching_hours NUMERIC;
