-- ============================================================
-- Cleanup duplicate programs (run in Supabase SQL Editor).
--
-- Deletes each named program AND its subjects → chapters → topics
-- (faculty_subjects cascade too; batch_schedules/planners/tests just lose the
-- subject link). It runs as ONE transaction: if any program still has a batch
-- attached, the whole thing errors & rolls back (nothing deleted) — reassign
-- those batches first (Central → Batch Scheduler → Edit → change Program), then
-- re-run.
--
-- ⚠️ EDIT THE LIST BELOW: keep only the program names you want to REMOVE.
--    Keep whichever variant matches your final "All course" sheet.
-- ============================================================

DO $$
DECLARE
  pname TEXT;
  names TEXT[] := ARRAY[
    '11th-Commerce-CBSE Board',
    '12th-Commerce-CBSE Board',
    'CUET-Commerce'
    -- add more names to delete here, comma-separated
  ];
  pid UUID;
BEGIN
  FOREACH pname IN ARRAY names LOOP
    SELECT id INTO pid FROM programs WHERE name = pname;
    IF pid IS NULL THEN
      RAISE NOTICE 'Skipped (not found): %', pname;
      CONTINUE;
    END IF;
    DELETE FROM subjects WHERE program_id = pid;   -- chapters/topics cascade
    DELETE FROM programs WHERE id = pid;            -- errors here if a batch uses it
    RAISE NOTICE 'Deleted program: %', pname;
  END LOOP;
END $$;

-- After running, verify:
-- SELECT name, (SELECT count(*) FROM subjects s WHERE s.program_id = p.id) AS subjects
-- FROM programs p ORDER BY name;
