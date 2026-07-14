import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysToDate, daysBetween, toMinutes } from '@/lib/utils'
import { isDateInRange } from '@/lib/validation'
import { notifyUsers } from '@/lib/notifications'

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

/** All of a room's committed time (weekly recurring + dated planners),
 *  excluding a set of batch_planners row ids (the rows being moved). Mirrors
 *  facultyBusyExcluding — one classroom can only host one class at a time. */
async function classroomBusyExcluding(
  supabase: SupabaseClient,
  classroomId: string,
  excludeIds: string[]
): Promise<{ weekly: WeeklyBusy[]; dated: DatedBusy[] }> {
  const [weeklyRes, datedRes] = await Promise.all([
    supabase
      .from('batch_schedules')
      .select('day_of_week, start_time, end_time')
      .eq('classroom_id', classroomId),
    supabase
      .from('batch_planners')
      .select('id, planned_date, start_time, duration_minutes')
      .eq('classroom_id', classroomId)
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

/** Does a proposed lecture conflict with the faculty's (or room's) other commitments? */
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

  // The batch's weekly timetable decides which room each subject runs in — a
  // dated planner lecture inherits its room from its subject's schedule row.
  const { data: sched } = await supabase
    .from('batch_schedules')
    .select('subject_id, classroom_id')
    .eq('batch_id', batch.id)
  const roomBySubject = new Map<string, string>()
  for (const s of (sched ?? []) as { subject_id: string | null; classroom_id: string | null }[]) {
    if (s.subject_id && s.classroom_id) roomBySubject.set(s.subject_id, s.classroom_id)
  }

  const busyCache: Record<string, { weekly: WeeklyBusy[]; dated: DatedBusy[] }> = {}
  const roomBusyCache: Record<string, { weekly: WeeklyBusy[]; dated: DatedBusy[] }> = {}
  const toInsert: Record<string, unknown>[] = []

  for (const l of lectures) {
    const date = l.planned_date as string
    const label = `${l.topic_name || 'Lecture'} (${date})`
    const facultyId = l.faculty_id as string | null

    // Faculty is OPTIONAL — a lecture can be left unassigned (TBD) and the
    // teacher filled in later. Only validate the centre when one is set.
    if (facultyId && !centreFacultyIds.has(facultyId)) { errors.push(`${label}: faculty does not teach at this batch's centre`); continue }
    if (!isDateInRange(new Date(date + 'T12:00:00'), batch.start_date, batch.end_date)) {
      errors.push(`${label}: outside batch date range`)
      continue
    }

    const classroomId = l.subject_id ? roomBySubject.get(l.subject_id as string) ?? null : null

    if (l.start_time) {
      const st = (l.start_time as string).slice(0, 5)
      const dur = l.duration_minutes as number
      const slot = { date, start: toMinutes(st), end: toMinutes(st) + dur }

      // Faculty conflict only matters when a teacher is actually assigned.
      let busy: { weekly: WeeklyBusy[]; dated: DatedBusy[] } | null = null
      if (facultyId) {
        if (!busyCache[facultyId]) busyCache[facultyId] = await facultyBusyExcluding(supabase, facultyId, [])
        busy = busyCache[facultyId]
        const reason = conflictReason(date, l.start_time as string, dur, busy)
        if (reason) { errors.push(`${label}: ${reason}`); continue }
      }

      // A room is one class at a time — check both weekly + other dated lectures.
      let roomBusy: { weekly: WeeklyBusy[]; dated: DatedBusy[] } | null = null
      if (classroomId) {
        if (!roomBusyCache[classroomId]) roomBusyCache[classroomId] = await classroomBusyExcluding(supabase, classroomId, [])
        roomBusy = roomBusyCache[classroomId]
        const rReason = conflictReason(date, l.start_time as string, dur, roomBusy)
        if (rReason) { errors.push(`${label}: room ${rReason}`); continue }
      }

      // Both clear — reserve the slot so later lectures in this planner see it.
      if (busy) busy.dated.push(slot)
      if (roomBusy) roomBusy.dated.push(slot)
    }

    toInsert.push({
      batch_id: batch.id,
      subject_id: l.subject_id,
      chapter: l.chapter,
      topic_name: l.topic_name,
      faculty_id: facultyId,
      classroom_id: classroomId,
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

  let syncErr: { message: string } | null = null
  if (stage === 'Faculty Assigned') {
    const today = new Date().toISOString().split('T')[0]
    // Lectures already in the past are done — auto-confirm them so they sit on
    // the faculty calendar without asking for confirmation. Only upcoming
    // lectures (today onward) go to the faculty to confirm.
    const past = await supabase.from('batch_planners').update({ stage: 'Confirmed' }).eq('link_id', linkId).lt('planned_date', today)
    const upcoming = await supabase.from('batch_planners').update({ stage: 'Faculty Assigned' }).eq('link_id', linkId).gte('planned_date', today)
    syncErr = past.error ?? upcoming.error ?? null

    // Alert only faculty who actually have upcoming lectures to confirm
    // (skip unassigned/TBD lectures — no one to notify yet).
    const { data } = await supabase.from('batch_planners').select('faculty_id').eq('link_id', linkId).gte('planned_date', today)
    await notifyUsers(supabase, (data ?? []).map((r) => r.faculty_id as string | null).filter((id): id is string => !!id), {
      type: 'planner', title: 'New planner assigned', body: 'Review and confirm your upcoming lectures.', link: '/faculty/planners',
    })
  } else {
    const { error } = await supabase.from('batch_planners').update({ stage }).eq('link_id', linkId)
    syncErr = error
  }
  return { error: syncErr?.message ?? null }
}

// --- Cascade shift on reschedule / cancellation ---------------------------

type TargetRow = {
  id: string
  link_id: string | null
  faculty_id: string | null
  classroom_id: string | null
  planned_date: string
  start_time: string | null
  duration_minutes: number
}

const NO_BUSY = (): { weekly: WeeklyBusy[]; dated: DatedBusy[] } => ({ weekly: [], dated: [] })

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
    .select('id, link_id, faculty_id, classroom_id, planned_date, start_time, duration_minutes')
    .eq('id', rowId)
    .single<TargetRow>()
  if (!target) return { ok: false, shifted: 0, error: 'Lecture not found.' }

  const delta = daysBetween(target.planned_date, newDate)
  const targetTime = newTime || target.start_time

  // Subsequent lectures of the SAME teacher in this planner-link (a planner can
  // span many teachers — only the requesting teacher's later lectures slide).
  // A TBD (no-faculty) lecture has no "same teacher" chain, so only it moves.
  let subsequent: TargetRow[] = []
  if (target.link_id && target.faculty_id) {
    const { data } = await supabase
      .from('batch_planners')
      .select('id, link_id, faculty_id, classroom_id, planned_date, start_time, duration_minutes')
      .eq('link_id', target.link_id)
      .eq('faculty_id', target.faculty_id)
      .gt('planned_date', target.planned_date)
    subsequent = (data ?? []) as TargetRow[]
  }

  const moving = [target, ...subsequent]
  const movingIds = moving.map((m) => m.id)
  const busy = target.faculty_id ? await facultyBusyExcluding(supabase, target.faculty_id, movingIds) : NO_BUSY()
  const roomBusyCache: Record<string, { weekly: WeeklyBusy[]; dated: DatedBusy[] }> = {}

  const updates: { id: string; planned_date: string; start_time: string | null }[] = []
  for (const row of moving) {
    const isTarget = row.id === target.id
    const propDate = isTarget ? newDate : addDaysToDate(row.planned_date, delta)
    const propTime = isTarget ? targetTime : row.start_time
    if (propTime) {
      const reason = conflictReason(propDate, propTime, row.duration_minutes, busy)
      if (reason) return { ok: false, shifted: 0, error: `Cannot reschedule: ${reason}.` }

      let roomBusy: { weekly: WeeklyBusy[]; dated: DatedBusy[] } | null = null
      if (row.classroom_id) {
        if (!roomBusyCache[row.classroom_id]) roomBusyCache[row.classroom_id] = await classroomBusyExcluding(supabase, row.classroom_id, movingIds)
        roomBusy = roomBusyCache[row.classroom_id]
        const rReason = conflictReason(propDate, propTime, row.duration_minutes, roomBusy)
        if (rReason) return { ok: false, shifted: 0, error: `Cannot reschedule: room ${rReason}.` }
      }

      const slot = { date: propDate, start: toMinutes(propTime.slice(0, 5)), end: toMinutes(propTime.slice(0, 5)) + row.duration_minutes }
      busy.dated.push(slot)
      if (roomBusy) roomBusy.dated.push(slot)
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

/** Add ONE extra lecture, cloning an existing (anchor) lecture's batch, link,
 *  faculty, subject, room, topic & chapter — for "I need one more class on this
 *  topic". No cascade (it's an addition, not a move), but the new slot is still
 *  validated against the faculty's and the room's other commitments. */
export async function addExtraLecture(
  supabase: SupabaseClient,
  anchorRowId: string,
  newDate: string,
  newTime: string | null,
  durationMinutes?: number,
  override?: { topic_name?: string | null; chapter?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  const { data: anchor } = await supabase
    .from('batch_planners')
    .select('batch_id, link_id, faculty_id, classroom_id, subject_id, chapter, topic_name, duration_minutes, start_time, stage')
    .eq('id', anchorRowId)
    .single<{
      batch_id: string
      link_id: string | null
      faculty_id: string | null
      classroom_id: string | null
      subject_id: string | null
      chapter: string
      topic_name: string
      duration_minutes: number
      start_time: string | null
      stage: string
    }>()
  if (!anchor) return { ok: false, error: 'Original lecture not found.' }

  const startTime = newTime || anchor.start_time
  if (!startTime) return { ok: false, error: 'Pick a start time for the extra class.' }
  const dur = durationMinutes && durationMinutes > 0 ? durationMinutes : anchor.duration_minutes

  // Faculty must be free at the new slot (only when the lecture has a teacher).
  if (anchor.faculty_id) {
    const facBusy = await facultyBusyExcluding(supabase, anchor.faculty_id, [])
    const facReason = conflictReason(newDate, startTime, dur, facBusy)
    if (facReason) return { ok: false, error: `Faculty ${facReason}.` }
  }

  // The room must be free too (one class per room at a time).
  if (anchor.classroom_id) {
    const roomBusy = await classroomBusyExcluding(supabase, anchor.classroom_id, [])
    const roomReason = conflictReason(newDate, startTime, dur, roomBusy)
    if (roomReason) return { ok: false, error: `Room ${roomReason}.` }
  }

  const topicName = override?.topic_name?.trim() ? override.topic_name.trim() : anchor.topic_name
  const chapter = override?.chapter?.trim() ? override.chapter.trim() : anchor.chapter

  const { error } = await supabase.from('batch_planners').insert({
    batch_id: anchor.batch_id,
    subject_id: anchor.subject_id,
    chapter: chapter,
    topic_name: topicName,
    faculty_id: anchor.faculty_id,
    classroom_id: anchor.classroom_id,
    planned_date: newDate,
    start_time: startTime,
    duration_minutes: dur,
    stage: anchor.stage,
    link_id: anchor.link_id,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Cancel one materialised lecture and close the gap: later lectures of the
 *  same link slide earlier to the freed slot, preserving relative spacing. */
export async function cascadeCancel(
  supabase: SupabaseClient,
  rowId: string
): Promise<{ ok: boolean; shifted: number; error?: string }> {
  const { data: target } = await supabase
    .from('batch_planners')
    .select('id, link_id, faculty_id, classroom_id, planned_date, start_time, duration_minutes')
    .eq('id', rowId)
    .single<TargetRow>()
  if (!target) return { ok: false, shifted: 0, error: 'Lecture not found.' }

  let subsequent: TargetRow[] = []
  if (target.link_id && target.faculty_id) {
    const { data } = await supabase
      .from('batch_planners')
      .select('id, link_id, faculty_id, classroom_id, planned_date, start_time, duration_minutes')
      .eq('link_id', target.link_id)
      .eq('faculty_id', target.faculty_id)
      .gt('planned_date', target.planned_date)
      .order('planned_date', { ascending: true })
    subsequent = (data ?? []) as TargetRow[]
  }

  // Gap = distance to the next lecture; everything slides up by that much.
  const delta = subsequent.length > 0 ? daysBetween(target.planned_date, subsequent[0].planned_date) : 0

  if (subsequent.length > 0 && delta > 0 && target.faculty_id) {
    const excludeIds = [target.id, ...subsequent.map((s) => s.id)]
    const busy = await facultyBusyExcluding(supabase, target.faculty_id, excludeIds)
    const roomBusyCache: Record<string, { weekly: WeeklyBusy[]; dated: DatedBusy[] }> = {}
    const updates: { id: string; planned_date: string }[] = []
    for (const row of subsequent) {
      const propDate = addDaysToDate(row.planned_date, -delta)
      if (row.start_time) {
        const reason = conflictReason(propDate, row.start_time, row.duration_minutes, busy)
        if (reason) return { ok: false, shifted: 0, error: `Cannot cancel & shift: ${reason}.` }

        let roomBusy: { weekly: WeeklyBusy[]; dated: DatedBusy[] } | null = null
        if (row.classroom_id) {
          if (!roomBusyCache[row.classroom_id]) roomBusyCache[row.classroom_id] = await classroomBusyExcluding(supabase, row.classroom_id, excludeIds)
          roomBusy = roomBusyCache[row.classroom_id]
          const rReason = conflictReason(propDate, row.start_time, row.duration_minutes, roomBusy)
          if (rReason) return { ok: false, shifted: 0, error: `Cannot cancel & shift: room ${rReason}.` }
        }

        const slot = { date: propDate, start: toMinutes(row.start_time.slice(0, 5)), end: toMinutes(row.start_time.slice(0, 5)) + row.duration_minutes }
        busy.dated.push(slot)
        if (roomBusy) roomBusy.dated.push(slot)
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
