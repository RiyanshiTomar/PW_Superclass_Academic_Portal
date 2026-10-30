import type { SupabaseClient } from '@supabase/supabase-js'
import { toMinutes, weeklySlotActiveOn, WEEKLY_SLOT_COLS } from '@/lib/utils'
import { fetchAllIn } from '@/lib/supabase/fetch-all'

// ============================================================
// Which lectures were actually CLASSES on a date. A class happens only where
// the batch's weekly timetable (Batch Scheduler) has a slot running that day;
// each running slot is matched to the planner row of the same batch + subject
// with the closest start time. Planner rows sitting on a day with no running
// slot (e.g. after the timetable was cut short) are not classes and must not
// be audited. Daily Lecture Audit and the Audit Report both use this, so they
// always agree.
// ============================================================

type SlotLike = { batch_id: string; subject_id: string | null; start_time: string }
type LectureLike = { id: string; batch_id: string; subject_id: string | null; start_time: string | null; is_buffer: boolean; status: string }

export type ClassPick<S, P> = { kind: 'planned' | 'buffer' | 'unplanned'; p: P | null; slot: S }

/** `slots` = the weekly slots RUNNING on the date; `lectures` = that date's planner rows. */
export function matchClasses<S extends SlotLike, P extends LectureLike>(slots: S[], lectures: P[]): ClassPick<S, P>[] {
  const used = new Set<string>()
  const mins = (t: string | null) => (t ? toMinutes(t.slice(0, 5)) : 0)
  // Prefer a real lecture, then a cancellation marker, then a buffer.
  const rank = (p: P) => (!p.is_buffer && p.status !== 'cancelled' ? 0 : p.status === 'cancelled' ? 1 : 2)
  const picks: ClassPick<S, P>[] = []
  for (const s of [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    const cands = lectures.filter((p) => !used.has(p.id) && p.batch_id === s.batch_id && p.subject_id === s.subject_id)
    // A cancel/reschedule marker at exactly this slot's time belongs to THIS
    // class (not to another class of the same subject that day) — it wins.
    const exact = (p: P) => (p.status === 'cancelled' && mins(p.start_time) === mins(s.start_time) ? 0 : 1)
    cands.sort((a, b) => exact(a) - exact(b) || rank(a) - rank(b) || Math.abs(mins(a.start_time) - mins(s.start_time)) - Math.abs(mins(b.start_time) - mins(s.start_time)))
    const p = cands[0] ?? null
    if (p) used.add(p.id)
    if (p?.status === 'cancelled') continue // class cancelled for this date
    if (p && !p.is_buffer) picks.push({ kind: 'planned', p, slot: s })
    else picks.push({ kind: p ? 'buffer' : 'unplanned', p, slot: s })
  }
  return picks
}

type ClassSlot = SlotLike & { day_of_week: number; effective_from: string | null; effective_to: string | null; batches?: unknown }
type DatedLecture = LectureLike & { planned_date: string | null }

/** Ids of the lectures that are real classes on their own date, from the
 *  given planner rows (include buffers + cancel markers of those batches/dates
 *  so they compete for slots correctly) and the batches' weekly slots
 *  (selected with day_of_week + WEEKLY_SLOT_COLS). */
export function classIdsFromRows(lectures: DatedLecture[], slots: ClassSlot[]): Set<string> {
  const ids = new Set<string>()
  const byDate = new Map<string, DatedLecture[]>()
  for (const l of lectures) if (l.planned_date) byDate.set(l.planned_date, [...(byDate.get(l.planned_date) ?? []), l])
  const slotsByDow = new Map<number, ClassSlot[]>()
  for (const s of slots) slotsByDow.set(s.day_of_week, [...(slotsByDow.get(s.day_of_week) ?? []), s])
  for (const [date, ls] of byDate) {
    const batches = new Set(ls.map((l) => l.batch_id))
    const dow = new Date(date + 'T12:00:00').getDay()
    const running = (slotsByDow.get(dow) ?? []).filter((s) => batches.has(s.batch_id) && weeklySlotActiveOn(s, date))
    for (const pick of matchClasses(running, ls)) if (pick.kind === 'planned' && pick.p) ids.add(pick.p.id)
  }
  return ids
}

/** Ids of the planner lectures of these batches, dated from..to, that are real
 *  classes (sit on a running timetable slot). Use it wherever a lecture is
 *  treated as a class: clash checks, hours taught, calendars, attendance. */
export async function classLectureIds(supabase: SupabaseClient, batchIds: string[], from: string, to: string): Promise<Set<string>> {
  if (!batchIds.length) return new Set()
  const [l, s] = await Promise.all([
    fetchAllIn<DatedLecture>(batchIds, (chunk, a, b) => supabase.from('batch_planners')
      .select('id, batch_id, subject_id, start_time, planned_date, is_buffer, status')
      .in('batch_id', chunk).gte('planned_date', from).lte('planned_date', to).order('id').range(a, b)),
    fetchAllIn<ClassSlot>(batchIds, (chunk, a, b) => supabase.from('batch_schedules')
      .select(`batch_id, subject_id, day_of_week, start_time, ${WEEKLY_SLOT_COLS}`)
      .in('batch_id', chunk).order('id').range(a, b) as unknown as PromiseLike<{ data: ClassSlot[] | null; error: { message: string } | null }>),
  ])
  return classIdsFromRows(l.data, s.data)
}
