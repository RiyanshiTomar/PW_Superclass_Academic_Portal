-- ============================================================
-- Helper for the attendance "Link batch" dropdown: distinct batches from the
-- sheet with readable context (code, course, centre, #students) so opaque IDs
-- are recognisable. SECURITY INVOKER → RLS still applies (admin/central only).
-- Run once in Supabase SQL Editor.
-- ============================================================
CREATE OR REPLACE FUNCTION attendance_batches()
RETURNS TABLE(sheet_batch_id TEXT, batch_name TEXT, course TEXT, center TEXT, students BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT a.sheet_batch_id,
         a.batch_name,
         max(a.course)  AS course,
         max(a.center)  AS center,
         count(DISTINCT a.regno) AS students
  FROM attendance a
  GROUP BY a.sheet_batch_id, a.batch_name
  ORDER BY max(a.center) NULLS LAST, max(a.course) NULLS LAST;
$$;
