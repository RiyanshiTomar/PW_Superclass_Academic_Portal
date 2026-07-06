import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysToDate, daysBetween, toMinutes } from '@/lib/utils'
import { isDateInRange } from '@/lib/validation'

// ============================================================
// Planner engine: create planners, assign (materialise) them onto
// batches with faculty + overlap validation, drive stages, and
// cascade-shift the rest of a planner when a lecture is rescheduled
// or cancelled. `batch_planners` is the materialised (concrete) table.
// ============================================================

export type PlannerLectureInput = {
  subject_id: string | null
  faculty_id: string | null
  chapter: string
  topic_name: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
}

export type BatchLite = { id: string; centre_id: string; start_date: string; end_date: string }

type RowResult = { imported: number; errors: string[] }

// --- Faculty availability (for cascade re-validation) ---------------------

type WeeklyBusy = { day_of_week: number; start: number; end: number }
type DatedBusy = { date: string; start: number; end: number }

/** All of a faculty's committed time (weekly recurring + dated planners),
 *  excluding a set of batch_planners row ids (the rows being moved). */
async function facultyBusyExcluding(
  supabase: SupabaseClient,
  facultyId: string,
  excludeIds: string[]
): Promise<{ weekly: WeeklyBusy[]; dated: DatedBusy[] }> {
  const [weeklyRes, datedRes] = await Promise.all([
    supabase
      .from('batch_schedules')
      .select('day_of_week, start_time, end_time')
      .eq('faculty_id', facultyId),
    supabase
      .from('batch_planners')
      .select('id, planned_date, start_time, duration_minutes')
      .eq('faculty_id', facultyId)
      .not('start_time', 'is', null),
  ])

  const weekly: WeeklyBusy[] = (weeklyRes.data ?? []).map((r) => ({
    day_of_week: r.day_of_week as number,
    start: toMinutes((r.start_time as string).slice(0, 5)),
    end: toMinutes((r.end_time as string).slice(0, 5)),
  }))

  const exclude = new Set(excludeIds)
  const dated: DatedBusy[] = (datedRes.data ?? [])
    .filter((r) => !exclude.has(r.id as string))
    .map((r) => {
      const start = toMinutes((r.start_time as string).slice(0, 5))
      return {
        date: r.planned_date as string,
        start,
        end: start + (r.duration_minutes as number),
      }
    })

  return { weekly, dated }
}

/** Does a proposed lecture conflict with the faculty's other commitments? */
function conflictReason(
  date: string,
  startTime: string,
  durationMinutes: number,
  busy: { weekly: WeeklyBusy[]; dated: DatedBusy[] }
): string | null {
  const start = toMinutes(startTime.slice(0, 5))
  const end = start + durationMinutes
  const dow = new Date(date + 'T12:00:00').getDay()

  for (const w of busy.weekly) {
    if (w.day_of_week === dow && start < w.end && end > w.start) {
      return `overlaps a recurring class on ${date}`
    }
  }
  for (const d of busy.dated) {
    if (d.date === date && start < d.end && end > d.start) {
      return `overlaps another planned lecture on ${date}`
    }
  }
  return null
}

// --- Create ---------------------------------------------------------------

export async function createPlanner(
  supabase: SupabaseClient,
  meta: { name: string; program_id: string | null; description: string; created_by: string | null },
  lectures: PlannerLectureInput[]
): Promise<{ plannerId: string } | { error: string }> {
  const { data: planner, error } = await supabase
    .from('planners')
    .insert({
      name: meta.name,
      program_id: meta.program_id,
      description: meta.description,
      created_by: meta.created_by,
    })
    .select('id')
    .single()

  if (error || !planner) return { error: error?.message ?? 'Failed to create planner.' }

  const rows = lectures.map((l, i) => ({
    planner_id: planner.id,
    subject_id: l.subject_id,
    faculty_id: l.faculty_id,
    chapter: l.chapter,
    topic_name: l.topic_name,
    planned_date: l.planned_date,
    start_time: l.start_time,
    duration_minutes: l.duration_minutes,
    sequence_no: i,
  }))

  const { error: lecErr } = await supabase.from('planner_lectures').insert(rows)
  if (lecErr) {
    // Roll back the empty planner so we don't leave orphans.
    await supabase.from('planners').delete().eq('id', planner.id)
    return { error: lecErr.message }
  }

  return { plannerId: planner.id }
}

// --- Assign / materialise -------------------------------------------------

/** Build the materialised batch_planners rows for a link. Each lecture uses
 *  its OWN faculty; validated against the batch date range, that the faculty
 *  teaches at the batch's centre, and the faculty's other commitments. */
async function materialise(
  supabase: SupabaseClient,
  linkId: string,
  plannerId: string,
  batch: BatchLite,
  stage: string
): Promise<RowResult> {
  const { data: lectures } = await supabase
    .from('planner_lectures')
    .select('id, subject_id, faculty_id, chapter, topic_name, planned_date, start_time, duration_minutes')
    .eq('planner_id', plannerId)
    .order('sequence_no', { ascending: true })

  const errors: string[] = []
  if (!lectures || lectures.length === 0) return { imported: 0, errors: ['Planner has no lectures.'] }

  // Which faculty actually teach at this batch's centre.
  const { data: centreFac } = await supabase.rpc('list_active_faculty', { p_centre_id: batch.centre_id })
  const centreFacultyIds = new Set(((centreFac as { id: string }[]) ?? []).map((f) => f.id))

  const busyCache: Record<string, { weekly: WeeklyBusy[]; dated: DatedBusy[] }> = {}
  const toInsert: Record<string, unknown>[] = []

  for (const l of lectures) {
    const date = l.planned_date as string
    const label = `${l.topic_name || 'Lecture'} (${date})`
    const facultyId = l.faculty_id as string | null

    if (!facultyId) { errors.push(`${label}: no faculty on this lecture`); continue }
    if (!centreFacultyIds.has(facultyId)) { errors.push(`${label}: faculty does not teach at this batch's centre`); continue }
    if (!isDateInRange(new Date(date + 'T12:00:00'), batch.start_date, batch.end_date)) {
      errors.push(`${label}: outside batch date range`)
      continue
    }

    if (l.start_time) {
      if (!busyCache[facultyId]) busyCache[facultyId] = await facultyBusyExcluding(supabase, facultyId, [])
      const busy = busyCache[facultyId]
      const reason = conflictReason(date, l.start_time as string, l.duration_minutes as number, busy)
      if (reason) { errors.push(`${label}: ${reason}`); continue }
      busy.dated.push({
        date,
        start: toMinutes((l.start_time as string).slice(0, 5)),
        end: toMinutes((l.start_time as string).slice(0, 5)) + (l.duration_minutes as number),
      })
    }

    toInsert.push({
      batch_id: batch.id,
      subject_id: l.subject_id,
      chapter: l.chapter,
      topic_name: l.topic_name,
      faculty_id: facultyId,
      planned_date: date,
      start_time: l.start_time,
      duration_minutes: l.duration_minutes,
      stage,
      link_id: linkId,
      planner_lecture_id: l.id,
    })
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from('batch_planners').insert(toInsert)
    if (error) return { imported: 0, errors: [error.message] }
  }
  return { imported: toInsert.length, errors }
}

/** Link a planner to a batch and materialise its lectures (each with its own faculty). */
export async function assignPlanner(
  supabase: SupabaseClient,
  args: { plannerId: string; batch: BatchLite; stage?: string }
): Promise<{ ok: boolean; linkId?: string; imported: number; errors: string[] }> {
  const stage = args.stage ?? 'Draft'

  // One planner can only be linked to a batch once (UNIQUE constraint).
  const { data: existing } = await supabase
    .from('batch_planner_links')
    .select('id')
    .eq('planner_id', args.plannerId)
    .eq('batch_id', args.batch.id)
    .maybeSingle()
  if (existing) {
    return { ok: false, imported: 0, errors: ['This planner is already linked to this batch.'] }
  }

  const { data: link, error } = await supabase
    .from('batch_planner_links')
    .insert({
      planner_id: args.plannerId,
      batch_id: args.batch.id,
      stage,
    })
    .select('id')
    .single()

  if (error || !link) return { ok: false, imported: 0, errors: [error?.message ?? 'Failed to link.'] }

  const result = await materialise(supabase, link.id, args.plannerId, args.batch, stage)

  if (result.imported === 0) {
    // Nothing usable landed — undo the link so it doesn't dangle.
    await supabase.from('batch_planner_links').delete().eq('id', link.id)
    return { ok: false, imported: 0, errors: result.errors.length ? result.errors : ['No lectures could be assigned.'] }
  }

  return { ok: true, linkId: link.id, imported: result.imported, errors: result.errors }
}

/** Re-materialise a link after its planner was edited (Draft/Rework only). */
export async function rematerialiseLink(
  supabase: SupabaseClient,
  linkId: string
): Promise<{ ok: boolean; imported: number; errors: string[] }> {
  const { data: link } = await supabase
    .from('batch_planner_links')
    .select('id, planner_id, batch_id, stage, batches(id, centre_id, start_date, end_date)')
    .eq('id', linkId)
    .single()
  if (!link) return { ok: false, imported: 0, errors: ['Link not found.'] }

  const b = Array.isArray(link.batches) ? link.batches[0] : link.batches
  if (!b) return { ok: false, imported: 0, errors: ['Batch not found.'] }

  await supabase.from('batch_planners').delete().eq('link_id', linkId)
  const result = await materialise(
    supabase,
    linkId,
    link.planner_id as string,
    { id: b.id, centre_id: b.centre_id, start_date: b.start_date, end_date: b.end_date },
    link.stage as string
  )
  return { ok: result.imported > 0, imported: result.imported, errors: result.errors }
}

// --- Stages ---------------------------------------------------------------

export async function setLinkStage(
  supabase: SupabaseClient,
  linkId: string,
  stage: string
): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { stage }
  if (stage === 'Faculty Assigned') patch.assigned_at = new Date().toISOString()

  const { error } = await supabase.from('batch_planner_links').update(patch).eq('id', linkId)
  if (error) return { error: error.message }

  const { error: syncErr } = await supabase
    .from('batch_planners')
    .update({ stage })
    .eq('link_id', linkId)
  return { error: syncErr?.message ?? null }
}

// --- Cascade shift on reschedule / cancellation ---------------------------

type TargetRow = {
  id: string
  link_id: string | null
  faculty_id: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
}

/** Reschedule one materialised lecture to a new date/time and slide every
 *  later lecture of the same planner-link by the same day delta, re-checking
 *  overlaps for the whole moved set. No partial writes: validate, then apply. */
export async function cascadeReschedule(
  supabase: SupabaseClient,
  rowId: string,
  newDate: string,
  newTime: string | null
): Promise<{ ok: boolean; shifted: number; error?: string }> {
  const { data: target } = await supabase
    .from('batch_planners')
    .select('id, link_id, faculty_id, planned_date, start_time, duration_minutes')
    .eq('id', rowId)
    .single<TargetRow>()
  if (!target) return { ok: false, shifted: 0, error: 'Lecture not found.' }

  const delta = daysBetween(target.planned_date, newDate)
  const targetTime = newTime || target.start_time

  // Subsequent lectures of the SAME teacher in this planner-link (a planner can
  // span many teachers — only the requesting teacher's later lectures slide).
  let subsequent: TargetRow[] = []
  if (target.link_id) {
    const { data } = await supabase
      .from('batch_planners')
      .select('id, link_id, faculty_id, planned_date, start_time, duration_minutes')
      .eq('link_id', target.link_id)
      .eq('faculty_id', target.faculty_id)
      .gt('planned_date', target.planned_date)
    subsequent = (data ?? []) as TargetRow[]
  }

  const moving = [target, ...subsequent]
  const busy = await facultyBusyExcluding(
    supabase,
    target.faculty_id,
    moving.map((m) => m.id)
  )

  const updates: { id: string; planned_date: string; start_time: string | null }[] = []
  for (const row of moving) {
    const isTarget = row.id === target.id
    const propDate = isTarget ? newDate : addDaysToDate(row.planned_date, delta)
    const propTime = isTarget ? targetTime : row.start_time
    if (propTime) {
      const reason = conflictReason(propDate, propTime, row.duration_minutes, busy)
      if (reason) return { ok: false, shifted: 0, error: `Cannot reschedule: ${reason}.` }
      busy.dated.push({
        date: propDate,
        start: toMinutes(propTime.slice(0, 5)),
        end: toMinutes(propTime.slice(0, 5)) + row.duration_minutes,
      })
    }
    updates.push({ id: row.id, planned_date: propDate, start_time: propTime })
  }

  for (const u of updates) {
    const { error } = await supabase
      .from('batch_planners')
      .update({ planned_date: u.planned_date, start_time: u.start_time })
      .eq('id', u.id)
    if (error) return { ok: false, shifted: 0, error: error.message }
  }

  return { ok: true, shifted: subsequent.length }
}

/** Cancel one materialised lecture and close the gap: later lectures of the
 *  same link slide earlier to the freed slot, preserving relative spacing. */
export async function cascadeCancel(
  supabase: SupabaseClient,
  rowId: string
): Promise<{ ok: boolean; shifted: number; error?: string }> {
  const { data: target } = await supabase
    .from('batch_planners')
    .select('id, link_id, faculty_id, planned_date, start_time, duration_minutes')
    .eq('id', rowId)
    .single<TargetRow>()
  if (!target) return { ok: false, shifted: 0, error: 'Lecture not found.' }

  let subsequent: TargetRow[] = []
  if (target.link_id) {
    const { data } = await supabase
      .from('batch_planners')
      .select('id, link_id, faculty_id, planned_date, start_time, duration_minutes')
      .eq('link_id', target.link_id)
      .eq('faculty_id', target.faculty_id)
      .gt('planned_date', target.planned_date)
      .order('planned_date', { ascending: true })
    subsequent = (data ?? []) as TargetRow[]
  }

  // Gap = distance to the next lecture; everything slides up by that much.
  const delta = subsequent.length > 0 ? daysBetween(target.planned_date, subsequent[0].planned_date) : 0

  if (subsequent.length > 0 && delta > 0) {
    const busy = await facultyBusyExcluding(
      supabase,
      target.faculty_id,
      [target.id, ...subsequent.map((s) => s.id)]
    )
    const updates: { id: string; planned_date: string }[] = []
    for (const row of subsequent) {
      const propDate = addDaysToDate(row.planned_date, -delta)
      if (row.start_time) {
        const reason = conflictReason(propDate, row.start_time, row.duration_minutes, busy)
        if (reason) return { ok: false, shifted: 0, error: `Cannot cancel & shift: ${reason}.` }
        busy.dated.push({
          date: propDate,
          start: toMinutes(row.start_time.slice(0, 5)),
          end: toMinutes(row.start_time.slice(0, 5)) + row.duration_minutes,
        })
      }
      updates.push({ id: row.id, planned_date: propDate })
    }
    for (const u of updates) {
      const { error } = await supabase
        .from('batch_planners')
        .update({ planned_date: u.planned_date })
        .eq('id', u.id)
      if (error) return { ok: false, shifted: 0, error: error.message }
    }
  }

  const { error: delErr } = await supabase.from('batch_planners').delete().eq('id', target.id)
  if (delErr) return { ok: false, shifted: 0, error: delErr.message }

  return { ok: true, shifted: subsequent.length }
}
