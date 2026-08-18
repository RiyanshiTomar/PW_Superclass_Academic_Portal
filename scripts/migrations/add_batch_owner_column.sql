-- Migration: Add Batch Owner System (Additional to existing Batch Manager)
-- This adds batch ownership by central team members as a separate feature

-- Step 1: Add batch_owner_id column to batches table (separate from batch_manager_id)
ALTER TABLE batches ADD COLUMN IF NOT EXISTS batch_owner_id UUID REFERENCES app_users(id) ON DELETE SET NULL;

-- Step 2: Create index for performance
CREATE INDEX IF NOT EXISTS idx_batches_batch_owner_id ON batches(batch_owner_id);

-- Step 3: Update existing RPC function to include owner info
CREATE OR REPLACE FUNCTION list_batches_with_manager()
RETURNS TABLE(
  id UUID, 
  name TEXT, 
  centre_id UUID, 
  centre_name TEXT,
  program_id UUID,
  program_name TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT,
  batch_manager_id UUID,
  manager_name TEXT,
  batch_owner_id UUID,
  owner_name TEXT
) AS $$
BEGIN
  RETURN QUERY
    SELECT 
      b.id,
      b.name,
      b.centre_id,
      c.name as centre_name,
      b.program_id,
      p.name as program_name,
      b.start_date,
      b.end_date,
      b.status,
      b.batch_manager_id,
      bm.full_name as manager_name,
      b.batch_owner_id,
      bo.full_name as owner_name
    FROM batches b
    LEFT JOIN centres c ON c.id = b.centre_id
    LEFT JOIN programs p ON p.id = b.program_id
    LEFT JOIN app_users bm ON bm.id = b.batch_manager_id
    LEFT JOIN app_users bo ON bo.id = b.batch_owner_id
    ORDER BY b.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 4: Create RPC function to get batches by owner
CREATE OR REPLACE FUNCTION get_batches_by_owner(owner_uuid UUID)
RETURNS TABLE(
  id UUID, 
  name TEXT, 
  centre_id UUID, 
  centre_name TEXT,
  program_id UUID,
  program_name TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT,
  batch_manager_id UUID,
  manager_name TEXT,
  batch_owner_id UUID,
  owner_name TEXT
) AS $$
BEGIN
  RETURN QUERY
    SELECT 
      b.id,
      b.name,
      b.centre_id,
      c.name as centre_name,
      b.program_id,
      p.name as program_name,
      b.start_date,
      b.end_date,
      b.status,
      b.batch_manager_id,
      bm.full_name as manager_name,
      b.batch_owner_id,
      bo.full_name as owner_name
    FROM batches b
    LEFT JOIN centres c ON c.id = b.centre_id
    LEFT JOIN programs p ON p.id = b.program_id
    LEFT JOIN app_users bm ON bm.id = b.batch_manager_id
    LEFT JOIN app_users bo ON bo.id = b.batch_owner_id
    WHERE (owner_uuid IS NULL OR b.batch_owner_id = owner_uuid)
    ORDER BY b.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;