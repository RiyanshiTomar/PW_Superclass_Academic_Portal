-- Per-lecture progress status for the Central "Edit Planner" tracking board.
--   'planned'   → in the plan, not yet confirmed
--   'confirmed' → confirmed (e.g. in a planning meeting) to be taught
--   'conducted' → already taught; planned_date holds the FINAL conducted date
-- Central-only tracking on the template; the faculty confirm flow (batch_planners.stage)
-- is separate and unchanged.
ALTER TABLE planner_lectures ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';
