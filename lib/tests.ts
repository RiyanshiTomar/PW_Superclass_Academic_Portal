import type { SupabaseClient } from '@supabase/supabase-js'
import { toMinutes, addDaysToDate } from '@/lib/utils'
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

// --- Aggregate test completion (the ≥60% syllabus gate) -------------------

export type TestCompletion = {
  pct: number
  topics_total: number
  topics_covered: number
  chapters: number
  warn: boolean
  threshold: number
  hasData: boolean
}

function aggregateCompletion(rows: EligibleChapter[], threshold: number): TestCompletion {
  if (rows.length === 0) return { pct: 0, topics_total: 0, topics_covered: 0, chapters: 0, warn: false, threshold, hasData: false }
  const topics_total = rows.reduce((a, c) => a + c.topics_total, 0)
  const topics_covered = rows.reduce((a, c) => a + c.topics_covered, 0)
  // Prefer a true topic-level ratio; fall back to averaging per-chapter % when
  // the master has no topics for these chapters (lecture-count basis).
  const pct = topics_total > 0
    ? Math.round((topics_covered / topics_total) * 100)
    : Math.round(rows.reduce((a, c) => a + c.pct, 0) / rows.length)
  return { pct, topics_total, topics_covered, chapters: rows.length, warn: pct < threshold, threshold, hasData: true }
}

/** How much of a test's syllabus is taught by its date.
 *  Part → only the selected chapters of the subject.
 *  Full → every chapter of every subject in the batch's program.
 *  Aggregated topics-taught / total; `warn` is true when below `threshold` (60). */
export async function getTestCompletion(
  supabase: SupabaseClient,
  args: {
    batchId: string
    byDate: string
    partType: string
    subjectId?: string | null
    chapterIds?: string[]
    programId?: string | null
    threshold?: number
  }
): Promise<TestCompletion> {
  const threshold = args.threshold ?? 60

  if (args.partType === 'Part') {
    if (!args.subjectId || !args.chapterIds || args.chapterIds.length === 0) {
      return { pct: 0, topics_total: 0, topics_covered: 0, chapters: 0, warn: false, threshold, hasData: false }
    }
    const all = await getEligibleChapters(supabase, { batchId: args.batchId, subjectId: args.subjectId, byDate: args.byDate, threshold })
    const ids = new Set(args.chapterIds)
    return aggregateCompletion(all.filter((c) => ids.has(c.chapter_id)), threshold)
  }

  // Full syllabus — resolve the batch's subjects (program first, planner fallback).
  let subjectIds: string[] = []
  let programId = args.programId ?? null
  if (!programId) {
    const { data: b } = await supabase.from('batches').select('program_id').eq('id', args.batchId).single<{ program_id: string | null }>()
    programId = b?.program_id ?? null
  }
  if (programId) {
    const { data } = await supabase.from('subjects').select('id').eq('program_id', programId)
    subjectIds = ((data ?? []) as { id: string }[]).map((s) => s.id)
  }
  if (subjectIds.length === 0) {
    const { data } = await supabase.from('batch_planners').select('subject_id').eq('batch_id', args.batchId).not('subject_id', 'is', null)
    subjectIds = [...new Set(((data ?? []) as { subject_id: string }[]).map((r) => r.subject_id))]
  }
  const rows: EligibleChapter[] = []
  for (const sid of subjectIds) {
    rows.push(...await getEligibleChapters(supabase, { batchId: args.batchId, subjectId: sid, byDate: args.byDate, threshold }))
  }
  return aggregateCompletion(rows, threshold)
}

// --- Free-slot finder (for the overlap popup) -----------------------------

export type FreeWindow = { start: string; end: string; minutes: number }

const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

/** The batch's open time windows on a date that can fit `durationMinutes`,
 *  within an 08:00–20:00 working day. Considers the weekly schedule, the
 *  planner lectures and every other test that day. */
export async function getBatchFreeWindows(
  supabase: SupabaseClient,
  args: { batchId: string; date: string; durationMinutes: number; ignoreTestId?: string; dayStart?: number; dayEnd?: number }
): Promise<FreeWindow[]> {
  const dayStart = args.dayStart ?? 8 * 60
  const dayEnd = args.dayEnd ?? 20 * 60
  const dow = new Date(args.date + 'T12:00:00').getDay()
  const busy: [number, number][] = []

  const { data: wk } = await supabase.from('batch_schedules').select('start_time, end_time').eq('batch_id', args.batchId).eq('day_of_week', dow)
  for (const r of (wk ?? []) as { start_time: string; end_time: string }[]) busy.push([toMinutes(r.start_time.slice(0, 5)), toMinutes(r.end_time.slice(0, 5))])

  const { data: pl } = await supabase.from('batch_planners').select('start_time, duration_minutes').eq('batch_id', args.batchId).eq('planned_date', args.date).not('start_time', 'is', null)
  for (const r of (pl ?? []) as { start_time: string; duration_minutes: number }[]) { const s = toMinutes(r.start_time.slice(0, 5)); busy.push([s, s + (r.duration_minutes || 60)]) }

  let q = supabase.from('test_schedules').select('id, start_time, duration_minutes').eq('batch_id', args.batchId).eq('test_date', args.date)
  if (args.ignoreTestId) q = q.neq('id', args.ignoreTestId)
  const { data: ts } = await q
  for (const r of (ts ?? []) as { id: string; start_time: string; duration_minutes: number }[]) { const s = toMinutes(r.start_time.slice(0, 5)); busy.push([s, s + (r.duration_minutes || 60)]) }

  busy.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [s, e] of busy) {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e)
    else merged.push([s, e])
  }

  const free: FreeWindow[] = []
  let cur = dayStart
  for (const [s, e] of merged) {
    const gapEnd = Math.min(s, dayEnd)
    if (gapEnd - cur >= args.durationMinutes) free.push({ start: hhmm(cur), end: hhmm(gapEnd), minutes: gapEnd - cur })
    cur = Math.max(cur, e)
    if (cur >= dayEnd) break
  }
  if (dayEnd - cur >= args.durationMinutes) free.push({ start: hhmm(cur), end: hhmm(dayEnd), minutes: dayEnd - cur })
  return free
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
 *  Checks the faculty, the room, and the batch's own classes + other tests.
 *  With `testPriority`, the test is meant to TAKE the batch's class period, so
 *  same-time classes/planner lectures are ignored (they get shifted forward
 *  separately) — only another TEST can still block it. */
export async function validateTestSlot(supabase: SupabaseClient, slot: TestSlot, opts?: { testPriority?: boolean }): Promise<string | null> {
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

  // Test-priority: the test replaces the class period, so only ANOTHER TEST
  // (in this batch, for the invigilator, or in the room) can still block it.
  if (opts?.testPriority) {
    const bt = await testClash('batch_id', slot.batchId, 'This batch already has another test at that time.')
    if (bt) return bt
    if (slot.facultyId) { const ft = await testClash('faculty_id', slot.facultyId, 'The invigilator is assigned to another test at that time.'); if (ft) return ft }
    if (slot.classroomId) { const rt = await testClash('classroom_id', slot.classroomId, 'The room is booked for another test at that time.'); if (rt) return rt }
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

// --- Test priority: shift the clashing planner forward -------------------

/** Shift ONE subject's planner lectures (on/after `fromDate`) forward by one
 *  class-date each, freeing the slot; each moved lecture re-inherits its new
 *  day's time & room. Processes latest-first so no two collide mid-move. */
export async function shiftSubjectForward(supabase: SupabaseClient, batchId: string, subjectId: string, fromDate: string): Promise<number> {
  const { data: sched } = await supabase
    .from('batch_schedules')
    .select('day_of_week, start_time, end_time, classroom_id')
    .eq('batch_id', batchId).eq('subject_id', subjectId)
  const slotByDay = new Map<number, { start: string; duration: number; classroom: string | null }>()
  for (const s of (sched ?? []) as { day_of_week: number; start_time: string; end_time: string; classroom_id: string | null }[]) {
    if (!slotByDay.has(s.day_of_week)) slotByDay.set(s.day_of_week, { start: s.start_time.slice(0, 5), duration: toMinutes(s.end_time.slice(0, 5)) - toMinutes(s.start_time.slice(0, 5)), classroom: s.classroom_id ?? null })
  }
  if (slotByDay.size === 0) return 0
  const days = Array.from(slotByDay.keys())

  const { data: b } = await supabase.from('batches').select('end_date').eq('id', batchId).single<{ end_date: string }>()
  const endBuf = addDaysToDate(b?.end_date ?? fromDate, 180)
  const classDates: string[] = []
  { const d = new Date(fromDate + 'T12:00:00'); const e = new Date(endBuf + 'T12:00:00'); while (d <= e) { if (days.includes(d.getDay())) classDates.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 1) } }
  // Tests the batch already has — a shifted class must never land on one.
  const { data: testsData } = await supabase
    .from('test_schedules')
    .select('test_date, start_time, duration_minutes')
    .eq('batch_id', batchId).gte('test_date', fromDate)
  const testsByDate = new Map<string, [number, number][]>()
  for (const t of (testsData ?? []) as { test_date: string; start_time: string; duration_minutes: number }[]) {
    const ts = toMinutes(t.start_time.slice(0, 5))
    const arr = testsByDate.get(t.test_date) ?? []
    arr.push([ts, ts + t.duration_minutes]); testsByDate.set(t.test_date, arr)
  }
  const slotFreeOfTest = (date: string) => {
    const slot = slotByDay.get(new Date(date + 'T12:00:00').getDay())
    if (!slot) return false
    const s = toMinutes(slot.start), e = s + slot.duration
    return !(testsByDate.get(date) ?? []).some(([ts, te]) => s < te && e > ts)
  }

  const { data: lecs } = await supabase
    .from('batch_planners')
    .select('id, planned_date')
    .eq('batch_id', batchId).eq('subject_id', subjectId).gte('planned_date', fromDate)
    .order('planned_date', { ascending: true })
  const lectures = (lecs ?? []) as { id: string; planned_date: string }[]

  // Greedy forward pack: each lecture goes to the earliest class-date that is
  // (a) strictly after its current date, (b) after the previous lecture's new
  // date, and (c) free of any test. Ascending order + a moving pointer keeps
  // the sequence collision-free and skips every test slot.
  let moved = 0
  let prevIdx = -1
  for (const l of lectures) {
    let j = prevIdx + 1
    while (j < classDates.length && (classDates[j] <= l.planned_date || !slotFreeOfTest(classDates[j]))) j++
    if (j >= classDates.length) break // ran out of room within the buffer window
    const nd = classDates[j]
    prevIdx = j
    const slot = slotByDay.get(new Date(nd + 'T12:00:00').getDay())
    await supabase.from('batch_planners').update({ planned_date: nd, start_time: slot?.start ?? null, duration_minutes: slot?.duration ?? 60, classroom_id: slot?.classroom ?? null }).eq('id', l.id)
    moved++
  }
  return moved
}

/** Sweep a whole batch so NO class/lecture sits on any of its tests — every
 *  test takes priority and pushes clashing lectures forward (test-aware, so a
 *  pushed lecture never lands on another test). Call this after (re)materialising
 *  a planner onto a batch that may already have tests. Returns lectures moved. */
export async function resolveTestConflicts(supabase: SupabaseClient, batchId: string): Promise<number> {
  const { data: tests } = await supabase
    .from('test_schedules')
    .select('test_date, start_time, duration_minutes')
    .eq('batch_id', batchId)
  let moved = 0
  for (const t of (tests ?? []) as { test_date: string; start_time: string; duration_minutes: number }[]) {
    moved += await shiftPlannerForTest(supabase, batchId, t.test_date, t.start_time, t.duration_minutes)
  }
  return moved
}

/** Give a test priority over the batch's class: shift every planner lecture
 *  that clashes with the test's time on that date (and its subject's later
 *  lectures) forward. Returns how many lectures moved. */
export async function shiftPlannerForTest(supabase: SupabaseClient, batchId: string, date: string, startTime: string, durationMinutes: number): Promise<number> {
  const s = toMinutes(startTime.slice(0, 5))
  const e = s + durationMinutes
  const { data: clashing } = await supabase
    .from('batch_planners')
    .select('subject_id, start_time, duration_minutes')
    .eq('batch_id', batchId).eq('planned_date', date).not('start_time', 'is', null)
  const subjects = new Set<string>()
  for (const r of (clashing ?? []) as { subject_id: string | null; start_time: string; duration_minutes: number }[]) {
    const rs = toMinutes(r.start_time.slice(0, 5))
    if (r.subject_id && rs < e && rs + r.duration_minutes > s) subjects.add(r.subject_id)
  }
  let moved = 0
  for (const sid of subjects) moved += await shiftSubjectForward(supabase, batchId, sid, date)
  return moved
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
  chapterIds: string[],
  opts?: { testPriority?: boolean }
): Promise<{ ok: boolean; id?: string; error?: string; shifted?: number }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
  }, { testPriority: opts?.testPriority })
  if (clash) return { ok: false, error: clash }

  // Passed (or nothing but a class was in the way) — if the test is taking the
  // class period, push the clashing planner lectures forward first.
  let shifted = 0
  if (opts?.testPriority) shifted = await shiftPlannerForTest(supabase, input.batch_id, input.test_date, input.start_time, input.duration_minutes)

  const { data, error } = await supabase.from('test_schedules').insert(input).select('id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create test.' }

  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const rows = chapterIds.map((cid) => ({ test_id: data.id, chapter_id: cid }))
    const { error: cErr } = await supabase.from('test_chapters').insert(rows)
    if (cErr) { await supabase.from('test_schedules').delete().eq('id', data.id); return { ok: false, error: cErr.message } }
  }
  return { ok: true, id: data.id, shifted }
}

export async function updateTest(
  supabase: SupabaseClient,
  testId: string,
  input: TestInput,
  chapterIds: string[],
  opts?: { testPriority?: boolean }
): Promise<{ ok: boolean; error?: string; shifted?: number }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
    ignoreTestId: testId,
  }, { testPriority: opts?.testPriority })
  if (clash) return { ok: false, error: clash }

  let shifted = 0
  if (opts?.testPriority) shifted = await shiftPlannerForTest(supabase, input.batch_id, input.test_date, input.start_time, input.duration_minutes)

  const { error } = await supabase.from('test_schedules').update(input).eq('id', testId)
  if (error) return { ok: false, error: error.message }

  await supabase.from('test_chapters').delete().eq('test_id', testId)
  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const { error: cErr } = await supabase.from('test_chapters').insert(chapterIds.map((cid) => ({ test_id: testId, chapter_id: cid })))
    if (cErr) return { ok: false, error: cErr.message }
  }
  return { ok: true, shifted }
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
