import type { SupabaseClient } from '@supabase/supabase-js'
import { daysBetween } from '@/lib/utils'

// ============================================================
// Syllabus pacing: for a batch, how far each subject has progressed vs its
// plan, whether it will finish before the batch end date, and where there's
// slack — so Central can pace lectures instead of cramming a subject at the end.
//
// Only REAL lectures count (is_buffer = false). "Done" = a real lecture whose
// date is in the past (it has been conducted). "Remaining" = future real
// lectures. A subject's finish date = its last real lecture's date.
// ============================================================

export type SubjectPace = {
  subjectId: string
  name: string
  totalLectures: number
  doneLectures: number
  remainingLectures: number
  totalHours: number
  doneHours: number
  finishDate: string | null       // last real lecture date
  marginDays: number | null       // end_date − finishDate (>0 finishes early, <0 overruns)
  status: 'done' | 'ahead' | 'on-track' | 'behind'
}

export type BatchPacing = {
  endDate: string
  todayISO: string
  daysLeft: number                 // end_date − today (0 if passed)
  subjects: SubjectPace[]
}

const AHEAD_MARGIN = 14  // finishes ≥ 2 weeks early → "ahead" (room to reallocate)

export async function computeBatchPacing(
  supabase: SupabaseClient,
  batchId: string,
  todayISO: string
): Promise<BatchPacing | null> {
  const { data: b } = await supabase.from('batches').select('end_date').eq('id', batchId).single<{ end_date: string }>()
  if (!b) return null
  const endDate = b.end_date

  const { data: lecs } = await supabase
    .from('batch_planners')
    .select('subject_id, planned_date, duration_minutes, subjects(name)')
    .eq('batch_id', batchId)
    .eq('is_buffer', false)

  type Row = { subject_id: string | null; planned_date: string; duration_minutes: number; subjects: { name: string } | { name: string }[] | null }
  const bySubject = new Map<string, { name: string; rows: Row[] }>()
  for (const r of (lecs ?? []) as Row[]) {
    const sid = r.subject_id
    if (!sid) continue
    const nm = Array.isArray(r.subjects) ? r.subjects[0]?.name : r.subjects?.name
    if (!bySubject.has(sid)) bySubject.set(sid, { name: nm ?? 'Subject', rows: [] })
    bySubject.get(sid)!.rows.push(r)
  }

  const subjects: SubjectPace[] = []
  for (const [subjectId, { name, rows }] of bySubject) {
    const totalLectures = rows.length
    const done = rows.filter((r) => r.planned_date < todayISO)
    const doneLectures = done.length
    const totalHours = Math.round((rows.reduce((s, r) => s + (r.duration_minutes || 0), 0) / 60) * 10) / 10
    const doneHours = Math.round((done.reduce((s, r) => s + (r.duration_minutes || 0), 0) / 60) * 10) / 10
    const finishDate = rows.length ? rows.reduce((mx, r) => (r.planned_date > mx ? r.planned_date : mx), rows[0].planned_date) : null
    const marginDays = finishDate ? daysBetween(finishDate, endDate) : null
    let status: SubjectPace['status']
    if (totalLectures > 0 && doneLectures >= totalLectures) status = 'done'
    else if (marginDays != null && marginDays < 0) status = 'behind'
    else if (marginDays != null && marginDays >= AHEAD_MARGIN) status = 'ahead'
    else status = 'on-track'
    subjects.push({ subjectId, name, totalLectures, doneLectures, remainingLectures: totalLectures - doneLectures, totalHours, doneHours, finishDate, marginDays, status })
  }
  subjects.sort((a, b2) => a.name.localeCompare(b2.name))

  const daysLeft = Math.max(0, daysBetween(todayISO, endDate))
  return { endDate, todayISO, daysLeft, subjects }
}

/** Short human warnings from a pacing snapshot (for the scheduling banner). */
export function pacingWarnings(p: BatchPacing): { behind: string[]; ahead: string[] } {
  const behind = p.subjects.filter((s) => s.status === 'behind').map((s) => `${s.name} runs ${Math.abs(s.marginDays ?? 0)} day(s) past the end date — add classes or start remaining topics sooner.`)
  const ahead = p.subjects.filter((s) => s.status === 'ahead').map((s) => `${s.name} finishes ${s.marginDays} day(s) early — there's slack here.`)
  return { behind, ahead }
}
