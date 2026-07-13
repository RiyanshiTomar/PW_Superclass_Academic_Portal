import type { SupabaseClient } from '@supabase/supabase-js'
import { toMinutes } from '@/lib/utils'
import { notify } from '@/lib/notifications'

// ============================================================
// Test scheduler engine: chapter completion (topics taught by a date),
// eligible-chapter picker for part tests, and full overlap validation
// (faculty, room, and the batch's own class planner + other tests).
// ============================================================

export const TEST_STAGES = ['Draft', 'Faculty Assigned', 'Confirmed', 'Rework'] as const

export type EligibleChapter = {
  chapter_id: string
  name: string
  pct: number
  topics_total: number
  topics_covered: number
  eligible: boolean
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && aE > bS
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

// --- Chapter completion ---------------------------------------------------

/** For a batch + subject, how far each chapter is covered by `byDate`, measured
 *  as (master topics of the chapter taught in the planner) / (total topics).
 *  Chapters with ≥ threshold% are eligible for a part test. */
export async function getEligibleChapters(
  supabase: SupabaseClient,
  args: { batchId: string; subjectId: string; byDate: string; threshold?: number }
): Promise<EligibleChapter[]> {
  const threshold = args.threshold ?? 60

  const { data: chaps } = await supabase
    .from('chapters')
    .select('id, name, sequence_no')
    .eq('subject_id', args.subjectId)
    .order('sequence_no')
  const chapters = (chaps ?? []) as { id: string; name: string }[]
  if (chapters.length === 0) return []

  const { data: tops } = await supabase
    .from('topics')
    .select('chapter_id, name')
    .in('chapter_id', chapters.map((c) => c.id))
  const topicsByChapter = new Map<string, string[]>()
  for (const t of (tops ?? []) as { chapter_id: string; name: string }[]) {
    if (!topicsByChapter.has(t.chapter_id)) topicsByChapter.set(t.chapter_id, [])
    topicsByChapter.get(t.chapter_id)!.push(t.name)
  }

  // ALL planner lectures for the batch (we need totals as well as what's taught).
  const { data: lecs } = await supabase
    .from('batch_planners')
    .select('chapter, topic_name, subject_id, planned_date')
    .eq('batch_id', args.batchId)
  const lectures = ((lecs ?? []) as { chapter: string | null; topic_name: string | null; subject_id: string | null; planned_date: string }[])
    .filter((l) => !l.subject_id || l.subject_id === args.subjectId) // this subject (or untagged)
  const taughtTopics = new Set<string>()
  for (const l of lectures) if (l.planned_date <= args.byDate && l.topic_name) taughtTopics.add(norm(l.topic_name))

  return chapters.map((ch) => {
    const tps = topicsByChapter.get(ch.id) ?? []
    let pct = 0
    let covered = 0
    if (tps.length > 0) {
      // Topic-level: taught topics / total topics.
      covered = tps.filter((t) => taughtTopics.has(norm(t))).length
      pct = Math.round((covered / tps.length) * 100)
    } else {
      // No topics in the master — measure from the batch's own planner:
      // lectures of this chapter taught by the test date / total planned for it.
      const chapLecs = lectures.filter((l) => norm(l.chapter) === norm(ch.name))
      const taught = chapLecs.filter((l) => l.planned_date <= args.byDate).length
      pct = chapLecs.length > 0 ? Math.round((taught / chapLecs.length) * 100) : 0
      covered = taught
    }
    return { chapter_id: ch.id, name: ch.name, pct, topics_total: tps.length, topics_covered: covered, eligible: pct >= threshold }
  })
}

// --- Slot validation ------------------------------------------------------

export type TestSlot = {
  batchId: string
  facultyId: string | null
  classroomId: string | null
  date: string
  startTime: string        // HH:MM
  durationMinutes: number
  ignoreTestId?: string
}

/** Returns a human error if the test slot clashes with anything, else null.
 *  Checks the faculty, the room, and the batch's own classes + other tests. */
export async function validateTestSlot(supabase: SupabaseClient, slot: TestSlot): Promise<string | null> {
  const s = toMinutes(slot.startTime.slice(0, 5))
  const e = s + slot.durationMinutes
  const dow = new Date(slot.date + 'T12:00:00').getDay()

  const weeklyClash = async (col: string, val: string, label: string) => {
    const { data } = await supabase.from('batch_schedules').select('start_time, end_time').eq(col, val).eq('day_of_week', dow)
    for (const r of (data ?? []) as { start_time: string; end_time: string }[]) {
      if (overlaps(s, e, toMinutes(r.start_time.slice(0, 5)), toMinutes(r.end_time.slice(0, 5)))) return label
    }
    return null
  }
  const plannerClash = async (col: string, val: string, label: string) => {
    const { data } = await supabase.from('batch_planners').select('start_time, duration_minutes').eq(col, val).eq('planned_date', slot.date).not('start_time', 'is', null)
    for (const r of (data ?? []) as { start_time: string; duration_minutes: number }[]) {
      const rs = toMinutes(r.start_time.slice(0, 5))
      if (overlaps(s, e, rs, rs + r.duration_minutes)) return label
    }
    return null
  }
  const testClash = async (col: string, val: string, label: string) => {
    let q = supabase.from('test_schedules').select('id, start_time, duration_minutes').eq(col, val).eq('test_date', slot.date)
    if (slot.ignoreTestId) q = q.neq('id', slot.ignoreTestId)
    const { data } = await q
    for (const r of (data ?? []) as { id: string; start_time: string; duration_minutes: number }[]) {
      const rs = toMinutes(r.start_time.slice(0, 5))
      if (overlaps(s, e, rs, rs + r.duration_minutes)) return label
    }
    return null
  }

  // The batch must be free — no class and no other test at this time.
  const batch =
    (await weeklyClash('batch_id', slot.batchId, 'This batch has a scheduled class at that time.')) ||
    (await plannerClash('batch_id', slot.batchId, 'This batch has a planned lecture at that time.')) ||
    (await testClash('batch_id', slot.batchId, 'This batch already has another test at that time.'))
  if (batch) return batch

  if (slot.facultyId) {
    const fac =
      (await weeklyClash('faculty_id', slot.facultyId, 'The faculty has a recurring class at that time.')) ||
      (await plannerClash('faculty_id', slot.facultyId, 'The faculty has a planned lecture at that time.')) ||
      (await testClash('faculty_id', slot.facultyId, 'The faculty is assigned to another test at that time.'))
    if (fac) return fac
  }

  if (slot.classroomId) {
    const room =
      (await weeklyClash('classroom_id', slot.classroomId, 'The room is occupied by a class at that time.')) ||
      (await plannerClash('classroom_id', slot.classroomId, 'The room has a planned lecture at that time.')) ||
      (await testClash('classroom_id', slot.classroomId, 'The room is booked for another test at that time.'))
    if (room) return room
  }

  return null
}

// --- Create / update / stages / reschedule --------------------------------

export type TestInput = {
  batch_id: string
  subject_id: string | null
  classroom_id: string | null
  faculty_id: string | null
  name: string
  test_date: string
  start_time: string
  duration_minutes: number
  test_type: string
  part_type: string
  created_by?: string | null
}

export async function createTest(
  supabase: SupabaseClient,
  input: TestInput,
  chapterIds: string[]
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
  })
  if (clash) return { ok: false, error: clash }

  const { data, error } = await supabase.from('test_schedules').insert(input).select('id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create test.' }

  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const rows = chapterIds.map((cid) => ({ test_id: data.id, chapter_id: cid }))
    const { error: cErr } = await supabase.from('test_chapters').insert(rows)
    if (cErr) { await supabase.from('test_schedules').delete().eq('id', data.id); return { ok: false, error: cErr.message } }
  }
  return { ok: true, id: data.id }
}

export async function updateTest(
  supabase: SupabaseClient,
  testId: string,
  input: TestInput,
  chapterIds: string[]
): Promise<{ ok: boolean; error?: string }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
    ignoreTestId: testId,
  })
  if (clash) return { ok: false, error: clash }

  const { error } = await supabase.from('test_schedules').update(input).eq('id', testId)
  if (error) return { ok: false, error: error.message }

  await supabase.from('test_chapters').delete().eq('test_id', testId)
  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const { error: cErr } = await supabase.from('test_chapters').insert(chapterIds.map((cid) => ({ test_id: testId, chapter_id: cid })))
    if (cErr) return { ok: false, error: cErr.message }
  }
  return { ok: true }
}

export async function setTestStage(
  supabase: SupabaseClient,
  testId: string,
  stage: string
): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { stage }
  if (stage === 'Faculty Assigned') patch.assigned_at = new Date().toISOString()
  const { error } = await supabase.from('test_schedules').update(patch).eq('id', testId)
  if (!error && stage === 'Faculty Assigned') {
    const { data } = await supabase.from('test_schedules').select('faculty_id, name').eq('id', testId).single<{ faculty_id: string | null; name: string }>()
    await notify(supabase, data?.faculty_id, { type: 'test', title: 'New test assigned', body: `Confirm the test${data?.name ? ` “${data.name}”` : ''}.`, link: '/faculty/tests' })
  }
  return { error: error?.message ?? null }
}

/** Reschedule a test to a new date/time after re-validating the slot. */
export async function rescheduleTest(
  supabase: SupabaseClient,
  testId: string,
  newDate: string,
  newTime: string
): Promise<{ ok: boolean; error?: string }> {
  const { data: t } = await supabase
    .from('test_schedules')
    .select('batch_id, faculty_id, classroom_id, duration_minutes')
    .eq('id', testId)
    .single<{ batch_id: string; faculty_id: string | null; classroom_id: string | null; duration_minutes: number }>()
  if (!t) return { ok: false, error: 'Test not found.' }

  const clash = await validateTestSlot(supabase, {
    batchId: t.batch_id, facultyId: t.faculty_id, classroomId: t.classroom_id,
    date: newDate, startTime: newTime, durationMinutes: t.duration_minutes, ignoreTestId: testId,
  })
  if (clash) return { ok: false, error: clash }

  const { error } = await supabase.from('test_schedules').update({ test_date: newDate, start_time: newTime }).eq('id', testId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
