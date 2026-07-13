import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Test results: student roster (from attendance), saving objective marks,
// importing subjective marks, and batch-wise performance summaries.
// ============================================================

export type RosterStudent = { regno: string; name: string }
export type ResultRow = { regno: string; student_name: string; marks: number | null; absent: boolean; source: string }
export type MarkEntry = { regno: string; student_name: string; marks: number | null; absent: boolean }

/** Roster for a batch = the students the Branch Head has assigned to it. */
export async function fetchRoster(
  supabase: SupabaseClient,
  batchId: string
): Promise<{ students: RosterStudent[]; error?: string }> {
  const { data, error } = await supabase
    .from('students')
    .select('regno, student_name')
    .eq('batch_id', batchId)
    .order('student_name')
  if (error) return { students: [], error: error.message }
  if (!data || data.length === 0) return { students: [], error: 'No students assigned to this batch yet — the Branch Head assigns students under Students.' }
  return { students: data.map((r) => ({ regno: r.regno as string, name: (r.student_name as string) ?? '' })) }
}

export async function fetchResults(supabase: SupabaseClient, testId: string): Promise<ResultRow[]> {
  const { data } = await supabase.from('test_results').select('regno, student_name, marks, absent, source').eq('test_id', testId)
  return (data ?? []) as ResultRow[]
}

/** Upsert marks for a test (one row per student). source = objective | subjective. */
export async function saveMarks(
  supabase: SupabaseClient,
  testId: string,
  entries: MarkEntry[],
  source: 'objective' | 'subjective'
): Promise<{ ok: boolean; saved: number; error?: string }> {
  const rows = entries.map((e) => ({
    test_id: testId,
    regno: e.regno,
    student_name: e.student_name,
    marks: e.absent ? null : e.marks,
    absent: e.absent,
    source,
    updated_at: new Date().toISOString(),
  }))
  if (rows.length === 0) return { ok: true, saved: 0 }
  const { error } = await supabase.from('test_results').upsert(rows, { onConflict: 'test_id,regno' })
  if (error) return { ok: false, saved: 0, error: error.message }
  return { ok: true, saved: rows.length }
}

/** Set the marks config (out of / pass) on a test. */
export async function setTestMarksConfig(
  supabase: SupabaseClient,
  testId: string,
  maxMarks: number | null,
  passMarks: number | null
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('test_schedules').update({ max_marks: maxMarks, pass_marks: passMarks }).eq('id', testId)
  return { error: error?.message ?? null }
}

export type Summary = {
  total: number
  entered: number
  attempted: number
  absent: number
  average: number | null
  highest: number | null
  lowest: number | null
  avgPct: number | null
  passCount: number | null
  passPct: number | null
}

export function summarize(results: ResultRow[], maxMarks: number | null, passMarks: number | null): Summary {
  const entered = results.filter((r) => r.absent || r.marks != null)
  const attempted = results.filter((r) => !r.absent && r.marks != null)
  const marks = attempted.map((r) => r.marks as number)
  const absent = results.filter((r) => r.absent).length
  const sum = marks.reduce((a, b) => a + b, 0)
  const average = marks.length ? Math.round((sum / marks.length) * 100) / 100 : null
  const highest = marks.length ? Math.max(...marks) : null
  const lowest = marks.length ? Math.min(...marks) : null
  const avgPct = average != null && maxMarks ? Math.round((average / maxMarks) * 1000) / 10 : null
  let passCount: number | null = null
  let passPct: number | null = null
  if (passMarks != null && attempted.length > 0) {
    passCount = marks.filter((m) => m >= passMarks).length
    passPct = Math.round((passCount / attempted.length) * 1000) / 10
  }
  return { total: results.length, entered: entered.length, attempted: attempted.length, absent, average, highest, lowest, avgPct, passCount, passPct }
}
