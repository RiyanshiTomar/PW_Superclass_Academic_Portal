import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/fetch-all'

// ============================================================
// The ACTIVE roster of a batch — the students assigned to it that haven't
// been discarded (left the batch). Every roster in the portal (marks entry,
// attendance, results, student overview) reads it from here.
// Works before migration-student-discard.sql is run (no status column yet:
// everyone counts as active).
// ============================================================

export type RosterRow = { regno: string; student_name: string | null }

export async function activeBatchStudents(
  supabase: SupabaseClient,
  batchId: string
): Promise<{ data: RosterRow[]; error: string | null }> {
  const run = (activeOnly: boolean) => fetchAll<RosterRow>((from, to) => {
    let q = supabase.from('students').select('regno, student_name').eq('batch_id', batchId)
    if (activeOnly) q = q.neq('status', 'discarded')
    return q.order('student_name').order('regno').range(from, to)
  })
  const res = await run(true)
  if (res.error && /status/i.test(res.error)) return run(false)
  return res
}
