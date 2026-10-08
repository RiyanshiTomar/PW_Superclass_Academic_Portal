import type { SupabaseClient } from '@supabase/supabase-js'
import { toMinutes, weeklySlotActiveOn, WEEKLY_SLOT_COLS } from '@/lib/utils'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { notifyUsers } from '@/lib/notifications'

// ============================================================
// Keep a batch's planner on its CURRENT weekly schedule.
//
// When the schedule changes (new days / times / date-range segments), upcoming
// lectures that no longer sit on a class of their subject become invisible
// "ghost" rows: the Calendar and Audit (rightly) don't show them, so they are
// never taught or audited. This re-places them:
//
//  • The subject's class-dates = every date from today to the batch end date
//    where its weekly slot is running (segment-aware), minus dates where that
//    slot would collide with one of the batch's tests.
//  • Lectures already on a class-date keep it (only time/room/teacher is
//    re-synced to the slot; an approved substitute teacher is kept).
//  • Each off-schedule lecture (wrong day, after the end date, or stacked on a
//    date another lecture already holds) is inserted at the first class-date on
//    or after its old date; lectures after it shift forward one class-date
//    until a free date absorbs it — so the topic ORDER never changes, and the
//    fewest lectures move. A lecture that can't fit before the end date is
//    left untouched and reported.
//  • Buffer rows then mirror reality: one per FREE class-date. Buffers on
//    dates a lecture now uses, or on dates with no class, are removed.
//
// Conducted, cancelled and past lectures are never touched. Every moved
// lecture rides its date's weekly slot, which the Batch Scheduler already
// validated — so no batch / faculty / room overlap is created.
// ============================================================

type Row = {
  id: string; subject_id: string | null; faculty_id: string | null; planned_date: string; start_time: string | null
  duration_minutes: number; classroom_id: string | null; status: string; is_buffer: boolean; link_id: string | null
  shifted_for_test_id: string | null; chapter: string | null; topic_name: string | null
}
type Seg = { subject_id: string | null; faculty_id: string | null; classroom_id: string | null; day_of_week: number; start_time: string; end_time: string; effective_from: string | null; effective_to: string | null; batches: unknown }

export type RealignSubject = { subjectId: string; moved: number; retimed: number; unplaced: number; buffersAdded: number; buffersRemoved: number }
export type RealignResult = {
  ok: boolean
  error?: string
  moved: number          // lectures given a new date
  retimed: number        // lectures kept on their date, time/room re-synced
  unplaced: number       // off-schedule lectures that don't fit before the end date
  buffersAdded: number
  buffersRemoved: number
  subjects: RealignSubject[]
  samples: string[]      // a few human-readable moves, for the preview
}

const dayOf = (d: string) => new Date(d + 'T12:00:00').getDay()

export async function realignBatchPlanner(
  supabase: SupabaseClient,
  batchId: string,
  opts: { dryRun?: boolean; today?: string } = {}
): Promise<RealignResult> {
  const empty: RealignResult = { ok: true, moved: 0, retimed: 0, unplaced: 0, buffersAdded: 0, buffersRemoved: 0, subjects: [], samples: [] }
  const today = opts.today ?? new Date().toISOString().split('T')[0]

  const { data: batch } = await supabase.from('batches').select('start_date, end_date, status').eq('id', batchId).single<{ start_date: string; end_date: string; status: string }>()
  if (!batch) return { ...empty, ok: false, error: 'Batch not found.' }
  if (batch.status === 'Merged') return empty
  const from = batch.start_date > today ? batch.start_date : today
  if (from > batch.end_date) return empty

  const [segRes, rowRes, linkRes, mapRes, subRes] = await Promise.all([
    supabase.from('batch_schedules').select(`subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time, ${WEEKLY_SLOT_COLS}`).eq('batch_id', batchId),
    fetchAll<Row>((f, t) => supabase.from('batch_planners')
      .select('id, subject_id, faculty_id, planned_date, start_time, duration_minutes, classroom_id, status, is_buffer, link_id, shifted_for_test_id, chapter, topic_name')
      .eq('batch_id', batchId).gte('planned_date', from).order('planned_date').order('start_time').order('id').range(f, t)),
    supabase.from('batch_planner_links').select('id, stage').eq('batch_id', batchId).limit(1).maybeSingle<{ id: string; stage: string }>(),
    supabase.from('test_batch_mappings').select('test_id').eq('batch_id', batchId),
    // Lectures where Central approved a substitute teacher keep that teacher.
    supabase.from('reschedule_requests').select('planner_id').eq('status', 'approved').ilike('review_notes', '%Substitute%'),
  ])
  const substituted = new Set((subRes.data ?? []).map((r) => r.planner_id as string))
  if (rowRes.error) return { ...empty, ok: false, error: rowRes.error }
  const segs = (segRes.data ?? []) as Seg[]

  // Batch tests (own + multi-batch) — a lecture never lands on one.
  const mapped = (mapRes.data ?? []).map((r) => r.test_id as string)
  let tq = supabase.from('test_schedules').select('test_date, start_time, duration_minutes').gte('test_date', from).neq('stage', 'Cancelled')
  tq = mapped.length ? tq.or(`batch_id.eq.${batchId},id.in.(${mapped.join(',')})`) : tq.eq('batch_id', batchId)
  const { data: testRows } = await tq
  const testsOn = new Map<string, [number, number][]>()
  for (const t of (testRows ?? []) as { test_date: string; start_time: string | null; duration_minutes: number }[]) {
    if (!t.start_time) continue
    const s = toMinutes(t.start_time.slice(0, 5))
    const arr = testsOn.get(t.test_date) ?? []
    arr.push([s, s + (t.duration_minutes || 60)]); testsOn.set(t.test_date, arr)
  }

  const out: RealignResult = { ...empty, subjects: [] }
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  const movedFaculty = new Set<string>() // faculty whose lecture dates change → notified
  const deletes: string[] = []
  const inserts: Record<string, unknown>[] = []

  const subjectIds = Array.from(new Set(segs.map((s) => s.subject_id).filter((x): x is string => !!x)))
  for (const sid of subjectIds) {
    const mySegs = segs.filter((s) => s.subject_id === sid)
    const slotFor = (date: string) => mySegs.find((s) => s.day_of_week === dayOf(date) && weeklySlotActiveOn(s, date)) ?? null

    // The subject's usable class-dates.
    const dates: string[] = []
    {
      const d = new Date(from + 'T12:00:00'), e = new Date(batch.end_date + 'T12:00:00')
      while (d <= e) {
        const ds = d.toISOString().split('T')[0]
        const sl = slotFor(ds)
        if (sl) {
          const s = toMinutes(sl.start_time.slice(0, 5)), en = toMinutes(sl.end_time.slice(0, 5))
          if (!(testsOn.get(ds) ?? []).some(([ts, te]) => s < te && en > ts)) dates.push(ds)
        }
        d.setDate(d.getDate() + 1)
      }
    }
    const idx = new Map(dates.map((d, i) => [d, i]))

    const rows = rowRes.data.filter((r) => r.subject_id === sid)
    const movable = rows.filter((r) => !r.is_buffer && r.status !== 'conducted' && r.status !== 'cancelled')
    // A cancelled marker or a conducted class already "uses" its date.
    const blocked = new Set(rows.filter((r) => !r.is_buffer && (r.status === 'conducted' || r.status === 'cancelled')).map((r) => r.planned_date))

    // occ[i] = the lecture holding class-date i.
    const occ: (Row | null)[] = dates.map(() => null)
    dates.forEach((d, i) => { if (blocked.has(d)) occ[i] = { id: '__blocked' } as Row })
    const ghosts: Row[] = []
    for (const r of movable) {
      const i = idx.get(r.planned_date)
      if (i != null && occ[i] == null) occ[i] = r
      else ghosts.push(r)
    }

    const stat: RealignSubject = { subjectId: sid, moved: 0, retimed: 0, unplaced: 0, buffersAdded: 0, buffersRemoved: 0 }
    const unplaced = new Set<string>()
    for (const g of ghosts) {
      // First class-date on/after the lecture's old date — never earlier
      // (a lecture is never pulled back in time without someone deciding to).
      const k = dates.findIndex((d) => d >= g.planned_date)
      if (k < 0) { unplaced.add(g.id); continue }
      let j = -1
      for (let i = k; i < occ.length; i++) if (occ[i] == null) { j = i; break }
      if (k >= occ.length || j < 0) { unplaced.add(g.id); continue }
      // Shift occupants k..j-1 forward one (skipping blocked dates).
      let carry: Row | null = g
      for (let i = k; i <= j && carry; i++) {
        if (occ[i]?.id === '__blocked') continue
        const cur: Row | null = occ[i]
        occ[i] = carry
        carry = cur
      }
    }
    stat.unplaced = unplaced.size

    // Apply: each placed lecture rides its date's slot.
    const used = new Set<string>()
    occ.forEach((r, i) => {
      if (!r || r.id === '__blocked') return
      const date = dates[i]
      used.add(date)
      const sl = slotFor(date)!
      const start = sl.start_time.slice(0, 5)
      const dur = toMinutes(sl.end_time.slice(0, 5)) - toMinutes(start)
      const patch: Record<string, unknown> = {}
      if (r.planned_date !== date) patch.planned_date = date
      if ((r.start_time ?? '').slice(0, 5) !== start) patch.start_time = sl.start_time
      if (r.duration_minutes !== dur) patch.duration_minutes = dur
      if (r.classroom_id !== sl.classroom_id) patch.classroom_id = sl.classroom_id
      // The slot's teacher (when the schedule names one) teaches the class —
      // unless Central approved a substitute for this lecture.
      if (sl.faculty_id && r.faculty_id !== sl.faculty_id && !substituted.has(r.id)) patch.faculty_id = sl.faculty_id
      if (!Object.keys(patch).length) return
      updates.push({ id: r.id, patch })
      if (patch.planned_date) {
        stat.moved++
        if (r.faculty_id) movedFaculty.add(r.faculty_id)
        if (out.samples.length < 8) out.samples.push(`“${r.topic_name || r.chapter || 'Lecture'}”: ${r.planned_date} → ${date}`)
      } else stat.retimed++
      if (patch.faculty_id) { movedFaculty.add(patch.faculty_id as string); if (r.faculty_id) movedFaculty.add(r.faculty_id) }
    })

    // Buffers = exactly the free class-dates.
    const keepBuffer = new Set<string>()
    for (const b of rows.filter((r) => r.is_buffer)) {
      const i = idx.get(b.planned_date)
      if (i == null || used.has(b.planned_date) || blocked.has(b.planned_date) || keepBuffer.has(b.planned_date)) {
        if (!b.shifted_for_test_id) { deletes.push(b.id); stat.buffersRemoved++ }
        continue
      }
      keepBuffer.add(b.planned_date)
      const sl = slotFor(b.planned_date)!
      if ((b.start_time ?? '').slice(0, 5) !== sl.start_time.slice(0, 5) || b.classroom_id !== sl.classroom_id) {
        updates.push({ id: b.id, patch: { start_time: sl.start_time, duration_minutes: toMinutes(sl.end_time.slice(0, 5)) - toMinutes(sl.start_time.slice(0, 5)), classroom_id: sl.classroom_id } })
      }
    }
    const link = linkRes.data
    const facultyId = mySegs.find((s) => s.faculty_id)?.faculty_id ?? movable.find((r) => r.faculty_id)?.faculty_id ?? null
    if (link && facultyId) {
      dates.forEach((d, i) => {
        if (occ[i] || keepBuffer.has(d)) return
        const sl = slotFor(d)!
        inserts.push({
          batch_id: batchId, link_id: link.id, subject_id: sid, faculty_id: sl.faculty_id ?? facultyId,
          planned_date: d, start_time: sl.start_time, duration_minutes: toMinutes(sl.end_time.slice(0, 5)) - toMinutes(sl.start_time.slice(0, 5)),
          classroom_id: sl.classroom_id, is_buffer: true, stage: link.stage || 'Draft', chapter: '', topic_name: '', status: 'planned',
        })
        stat.buffersAdded++
      })
    }

    out.moved += stat.moved; out.retimed += stat.retimed; out.unplaced += stat.unplaced
    out.buffersAdded += stat.buffersAdded; out.buffersRemoved += stat.buffersRemoved
    if (stat.moved || stat.retimed || stat.unplaced || stat.buffersAdded || stat.buffersRemoved) out.subjects.push(stat)
  }

  if (opts.dryRun) return out

  // Two-phase date writes are unnecessary (no unique constraint on dates);
  // apply updates, then buffer deletes/inserts.
  for (const u of updates) {
    const { error } = await supabase.from('batch_planners').update(u.patch).eq('id', u.id)
    if (error) return { ...out, ok: false, error: error.message }
  }
  for (let i = 0; i < deletes.length; i += 150) {
    const { error } = await supabase.from('batch_planners').delete().in('id', deletes.slice(i, i + 150)).eq('is_buffer', true)
    if (error) return { ...out, ok: false, error: error.message }
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase.from('batch_planners').insert(inserts.slice(i, i + 500))
    if (error) return { ...out, ok: false, error: error.message }
  }
  if (movedFaculty.size) {
    await notifyUsers(supabase, Array.from(movedFaculty), {
      type: 'planner', title: 'Lecture dates updated',
      body: 'Some of your upcoming lectures were updated (date, time or teacher) to match the batch’s current timetable. Please check your planner/calendar.',
      link: '/faculty/planners',
    })
  }
  return out
}
