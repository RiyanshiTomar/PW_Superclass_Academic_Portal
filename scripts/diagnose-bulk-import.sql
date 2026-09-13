-- Run this in Supabase SQL Editor to diagnose bulk test import failures
-- ============================================================

-- 1. Check if batch_id is nullable (multi-batch migration ran?)
SELECT column_name, is_nullable, data_type 
FROM information_schema.columns 
WHERE table_name = 'test_schedules' 
AND column_name IN ('batch_id', 'subject_id', 'start_time', 'part_type');

-- 2. Check if map_test_to_batches RPC exists
SELECT routine_name, routine_type 
FROM information_schema.routines 
WHERE routine_name IN ('map_test_to_batches', 'get_test_batches')
AND routine_schema = 'public';

-- 3. Check if test_batch_mappings table exists
SELECT table_name FROM information_schema.tables 
WHERE table_name = 'test_batch_mappings';

-- 4. Try a dry-run insert to see the real error (replace values as needed)
-- EXPLAIN only — does NOT actually insert
-- INSERT INTO test_schedules (batch_id, subject_id, name, test_date, start_time, duration_minutes, test_type, part_type)
-- VALUES ('your-batch-uuid', null, 'Test', '2026-09-12', '15:00', 120, 'Objective', 'Part');
