-- OPTIONAL: per-batch progress status on the materialised planner.
--   'planned'   → in the plan, not yet confirmed
--   'confirmed' → confirmed to be taught (a deliberate mark by Central)
--   'conducted' → already taught (its planned_date is in the past)
--
-- The Edit Planner "live batch" board shows planned/confirmed/conducted per
-- batch. Without this column the board still works (status is inferred from the
-- date and shown read-only); WITH it, Central can edit the status per batch too.
-- Separate from batch_planners.stage (the faculty confirm flow), which is unchanged.

ALTER TABLE batch_planners ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';

-- Backfill: any real class whose date has already passed is 'conducted'.
UPDATE batch_planners
   SET status = 'conducted'
 WHERE is_buffer = false
   AND planned_date < CURRENT_DATE
   AND status <> 'conducted';
