import { toMinutes } from '@/lib/utils'

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
    cands.sort((a, b) => rank(a) - rank(b) || Math.abs(mins(a.start_time) - mins(s.start_time)) - Math.abs(mins(b.start_time) - mins(s.start_time)))
    const p = cands[0] ?? null
    if (p) used.add(p.id)
    if (p?.status === 'cancelled') continue // class cancelled for this date
    if (p && !p.is_buffer) picks.push({ kind: 'planned', p, slot: s })
    else picks.push({ kind: p ? 'buffer' : 'unplanned', p, slot: s })
  }
  return picks
}
