# Migration Required: Add Faculty Employment Type to Test Scheduler

## Problem
The faculty dropdown in Test Scheduler is not showing employment types (Permanent / Hourly/Contract).

## Solution
Run this SQL migration to update the `list_active_faculty` function.

---

## Step 1: Open Supabase SQL Editor

1. Go to your Supabase project dashboard
2. Click on **SQL Editor** in the left sidebar
3. Click **New Query**

---

## Step 2: Copy and Run This SQL

```sql
-- Migration: Add faculty_type to list_active_faculty RPC
-- This updates the function to return faculty employment type

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
```

---

## Step 3: Execute and Verify

1. Click **Run** (or press Ctrl+Enter)
2. You should see: `Success. No rows returned`
3. Refresh your Test Scheduler page
4. Open faculty dropdown - you should now see employment types:
   - `Poonam Ramchandani (Permanent)`
   - `Tarun Swami (Hourly/Contract)`
   - etc.

---

## What Changed?

**Before:**
```typescript
// RPC returned: { id, full_name, email, centre_id }
"Poonam Ramchandani"
```

**After:**
```typescript
// RPC returns: { id, full_name, email, centre_id, faculty_type }
"Poonam Ramchandani (Permanent)"
```

---

## Troubleshooting

### Faculty types still not showing?

1. **Check if faculty_type is set in database:**
   ```sql
   SELECT full_name, faculty_type FROM app_users WHERE 'faculty' = ANY(roles);
   ```
   
2. **If faculty_type is NULL for some users, update them:**
   ```sql
   UPDATE app_users 
   SET faculty_type = 'Permanent' 
   WHERE 'faculty' = ANY(roles) AND faculty_type IS NULL;
   ```

3. **Hard refresh the page:** Ctrl+Shift+R (or Cmd+Shift+R on Mac)

---

## Files Modified

- ✅ `scripts/schema.sql` - Updated RPC definition
- ✅ `components/TestScheduler.tsx` - Added `faculty_type` to Faculty type
- ✅ `components/TestScheduler.tsx` - Enhanced dropdown to show employment type
- ✅ `scripts/migrations/add_faculty_type_to_rpc.sql` - Migration file (same SQL as above)

---

🎉 After migration, your Test Scheduler will show faculty employment types!
