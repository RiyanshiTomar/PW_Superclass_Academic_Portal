-- Migration: Add faculty_type to list_active_faculty RPC
-- This updates the function to return faculty employment type (Permanent / Hourly/Contract)

-- Step 1: Drop the old function
DROP FUNCTION IF EXISTS list_active_faculty(uuid);

-- Step 2: Create the new function with faculty_type
CREATE OR REPLACE FUNCTION list_active_faculty(p_centre_id UUID)
RETURNS TABLE(id UUID, full_name TEXT, email TEXT, centre_id UUID, faculty_type TEXT) AS $$
BEGIN
  IF p_centre_id IS NULL THEN
    -- Return all faculty with their primary centre (no duplicates)
    RETURN QUERY
      SELECT DISTINCT ON (u.id) u.id, u.full_name, u.email, uc.centre_id, u.faculty_type
      FROM app_users u
      JOIN user_centres uc ON uc.user_id = u.id
      WHERE u.status = 'active'
        AND ('faculty' = ANY(u.roles) OR u.role = 'faculty')
      ORDER BY u.id, uc.is_primary DESC;
  ELSE
    RETURN QUERY
      SELECT u.id, u.full_name, u.email, uc.centre_id, u.faculty_type
      FROM app_users u
      JOIN user_centres uc ON uc.user_id = u.id
      WHERE u.status = 'active'
        AND uc.centre_id = p_centre_id
        AND ('faculty' = ANY(u.roles) OR u.role = 'faculty')
      ORDER BY u.full_name;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
