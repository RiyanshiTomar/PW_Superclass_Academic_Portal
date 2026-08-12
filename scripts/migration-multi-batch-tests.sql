-- Multi-batch Test Support Migration
-- Allow one test to be mapped to multiple batches

-- Step 1: Create mapping table for test-batch relationships
CREATE TABLE IF NOT EXISTS test_batch_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES test_schedules(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Prevent duplicate mappings
  UNIQUE(test_id, batch_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_test_batch_mappings_test ON test_batch_mappings(test_id);
CREATE INDEX IF NOT EXISTS idx_test_batch_mappings_batch ON test_batch_mappings(batch_id);

-- Step 2: Migrate existing tests to the new mapping system
-- Move all current test-batch relationships to the mapping table
INSERT INTO test_batch_mappings (test_id, batch_id)
SELECT id as test_id, batch_id 
FROM test_schedules 
WHERE batch_id IS NOT NULL
ON CONFLICT (test_id, batch_id) DO NOTHING;

-- Step 3: RLS Policies (same as other test tables)
ALTER TABLE test_batch_mappings DISABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read test_batch_mappings" ON test_batch_mappings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write test_batch_mappings" ON test_batch_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Step 4: Create helper functions for multi-batch operations

-- Function to get all batches for a test
CREATE OR REPLACE FUNCTION get_test_batches(test_uuid UUID)
RETURNS TABLE(
  batch_id UUID,
  batch_name TEXT,
  centre_name TEXT,
  program_name TEXT
) 
LANGUAGE sql
AS $$
  SELECT 
    b.id as batch_id,
    b.name as batch_name,
    c.name as centre_name,
    p.name as program_name
  FROM test_batch_mappings tbm
  JOIN batches b ON b.id = tbm.batch_id
  LEFT JOIN centres c ON c.id = b.centre_id  
  LEFT JOIN programs p ON p.id = b.program_id
  WHERE tbm.test_id = test_uuid
  ORDER BY b.name;
$$;

-- Function to get all tests for a batch  
CREATE OR REPLACE FUNCTION get_batch_tests(batch_uuid UUID)
RETURNS TABLE(
  test_id UUID,
  test_name TEXT,
  test_date DATE,
  test_type TEXT,
  start_time TIME,
  duration_minutes INTEGER
)
LANGUAGE sql  
AS $$
  SELECT 
    ts.id as test_id,
    ts.name as test_name,
    ts.test_date,
    ts.test_type,
    ts.start_time,
    ts.duration_minutes
  FROM test_batch_mappings tbm
  JOIN test_schedules ts ON ts.id = tbm.test_id
  WHERE tbm.batch_id = batch_uuid
  ORDER BY ts.test_date DESC, ts.start_time;
$$;

-- Function to add test to multiple batches
CREATE OR REPLACE FUNCTION map_test_to_batches(
  test_uuid UUID,
  batch_uuids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  batch_uuid UUID;
  mapped_count INTEGER := 0;
BEGIN
  -- Clear existing mappings for this test
  DELETE FROM test_batch_mappings WHERE test_id = test_uuid;
  
  -- Add new mappings
  FOREACH batch_uuid IN ARRAY batch_uuids
  LOOP
    INSERT INTO test_batch_mappings (test_id, batch_id)
    VALUES (test_uuid, batch_uuid)
    ON CONFLICT (test_id, batch_id) DO NOTHING;
    
    mapped_count := mapped_count + 1;
  END LOOP;
  
  RETURN mapped_count;
END;
$$;

-- Step 5: Update test_schedules to make batch_id optional (backward compatibility)
-- Keep the original batch_id column but make it nullable for multi-batch tests
ALTER TABLE test_schedules ALTER COLUMN batch_id DROP NOT NULL;

-- Add comment to explain the new structure
COMMENT ON TABLE test_batch_mappings IS 'Maps tests to multiple batches. One test can be assigned to multiple batches.';
COMMENT ON COLUMN test_schedules.batch_id IS 'Legacy single batch ID. For multi-batch tests, use test_batch_mappings table.';

-- Step 6: Create view for backward compatibility
CREATE OR REPLACE VIEW test_schedules_with_batches AS
SELECT 
  ts.*,
  -- Get primary batch (first mapped batch or legacy batch_id)
  COALESCE(ts.batch_id, (
    SELECT batch_id 
    FROM test_batch_mappings 
    WHERE test_id = ts.id 
    ORDER BY created_at 
    LIMIT 1
  )) as primary_batch_id,
  -- Get batch count
  (
    SELECT COUNT(*) 
    FROM test_batch_mappings 
    WHERE test_id = ts.id
  ) as batch_count,
  -- Get batch names (comma separated)
  (
    SELECT STRING_AGG(b.name, ', ' ORDER BY b.name)
    FROM test_batch_mappings tbm
    JOIN batches b ON b.id = tbm.batch_id
    WHERE tbm.test_id = ts.id
  ) as batch_names
FROM test_schedules ts;