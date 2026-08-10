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
export async function shiftSubjectForward(supabase: SupabaseClient, batchId: string, subjectId: string, fromDate: string, testId?: string): Promise<{ moved: number; unmoved: number }> {
  const { data: sched } = await supabase
    .from('batch_schedules')
    .select('day_of_week, start_time, end_time, classroom_id')
    .eq('batch_id', batchId).eq('subject_id', subjectId)
  const slotByDay = new Map<number, { start: string; duration: number; classroom: string | null }>()
  for (const s of (sched ?? []) as { day_of_week: number; start_time: string; end_time: string; classroom_id: string | null }[]) {
    if (!slotByDay.has(s.day_of_week)) slotByDay.set(s.day_of_week, { start: s.start_time.slice(0, 5), duration: toMinutes(s.end_time.slice(0, 5)) - toMinutes(s.start_time.slice(0, 5)), classroom: s.classroom_id ?? null })
  }
  if (slotByDay.size === 0) return { moved: 0, unmoved: 0 }
  const days = Array.from(slotByDay.keys())

  const { data: b } = await supabase.from('batches').select('end_date').eq('id', batchId).single<{ end_date: string }>()
  const endDate = b?.end_date ?? fromDate
  // Class-dates are capped at the batch's OWN end date — a shift must reuse an
  // existing buffer date, never push the batch past its planned finish.
  const classDates: string[] = []
  { const d = new Date(fromDate + 'T12:00:00'); const e = new Date(endDate + 'T12:00:00'); while (d <= e) { if (days.includes(d.getDay())) classDates.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 1) } }

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

  // Only REAL lectures move — buffer (reserved/empty) rows are exactly the
  // free capacity a shifted lecture lands on, not something to move themselves.
  const { data: lecs } = await supabase
    .from('batch_planners')
    .select('id, planned_date')
    .eq('batch_id', batchId).eq('subject_id', subjectId).eq('is_buffer', false).gte('planned_date', fromDate)
    .order('planned_date', { ascending: true })
  const lectures = (lecs ?? []) as { id: string; planned_date: string }[]

  let moved = 0
  let prevIdx = -1
  for (const l of lectures) {
    let j = prevIdx + 1
    while (j < classDates.length && (classDates[j] <= l.planned_date || !slotFreeOfTest(classDates[j]))) j++
    if (j >= classDates.length) break // no buffer/class-date left within the batch's end date
    const nd = classDates[j]
    prevIdx = j
    const slot = slotByDay.get(new Date(nd + 'T12:00:00').getDay())
    const patch: Record<string, unknown> = { planned_date: nd, start_time: slot?.start ?? null, duration_minutes: slot?.duration ?? 60, classroom_id: slot?.classroom ?? null }
    if (testId) { patch.shifted_for_test_id = testId; patch.shifted_from_date = l.planned_date }
    await supabase.from('batch_planners').update(patch).eq('id', l.id)
    moved++
  }
  return { moved, unmoved: lectures.length - moved }
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
    const res = await shiftPlannerForTest(supabase, batchId, t.test_date, t.start_time, t.duration_minutes)
    moved += res.moved
  }
  return moved
}

/** Give a test priority over the batch's class: shift every planner lecture
 *  that clashes with the test's time on that date (and its subject's later
 *  lectures) forward. Returns how many lectures moved. */
export async function shiftPlannerForTest(supabase: SupabaseClient, batchId: string, date: string, startTime: string, durationMinutes: number, testId?: string): Promise<{ moved: number; unmoved: number }> {
  const s = toMinutes(startTime.slice(0, 5))
  const e = s + durationMinutes
  const { data: clashing } = await supabase
    .from('batch_planners')
    .select('subject_id, start_time, duration_minutes, is_buffer')
    .eq('batch_id', batchId).eq('planned_date', date).not('start_time', 'is', null)
  const subjects = new Set<string>()
  for (const r of (clashing ?? []) as { subject_id: string | null; start_time: string; duration_minutes: number; is_buffer: boolean }[]) {
    if (r.is_buffer) continue // a buffer slot has nothing real to "replace"
    const rs = toMinutes(r.start_time.slice(0, 5))
    if (r.subject_id && rs < e && rs + r.duration_minutes > s) subjects.add(r.subject_id)
  }
  let moved = 0, unmoved = 0
  for (const sid of subjects) {
    const res = await shiftSubjectForward(supabase, batchId, sid, date, testId)
    moved += res.moved; unmoved += res.unmoved
  }
  return { moved, unmoved }
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
): Promise<{ ok: boolean; id?: string; error?: string; shifted?: number; unshiftable?: number }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
  }, { testPriority: opts?.testPriority })
  if (clash) return { ok: false, error: clash }

  const { data, error } = await supabase.from('test_schedules').insert(input).select('id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create test.' }

  let shifted = 0, unshiftable = 0
  if (opts?.testPriority) {
    const res = await shiftPlannerForTest(supabase, input.batch_id, input.test_date, input.start_time, input.duration_minutes, data.id)
    shifted = res.moved; unshiftable = res.unmoved
  }

  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const rows = chapterIds.map((cid) => ({ test_id: data.id, chapter_id: cid }))
    const { error: cErr } = await supabase.from('test_chapters').insert(rows)
    if (cErr) { await supabase.from('test_schedules').delete().eq('id', data.id); return { ok: false, error: cErr.message } }
  }
  return { ok: true, id: data.id, shifted, unshiftable }
}

export async function updateTest(
  supabase: SupabaseClient,
  testId: string,
  input: TestInput,
  chapterIds: string[],
  opts?: { testPriority?: boolean }
): Promise<{ ok: boolean; error?: string; shifted?: number; unshiftable?: number }> {
  const clash = await validateTestSlot(supabase, {
    batchId: input.batch_id, facultyId: input.faculty_id, classroomId: input.classroom_id,
    date: input.test_date, startTime: input.start_time, durationMinutes: input.duration_minutes,
    ignoreTestId: testId,
  }, { testPriority: opts?.testPriority })
  if (clash) return { ok: false, error: clash }

  let shifted = 0, unshiftable = 0
  if (opts?.testPriority) {
    const res = await shiftPlannerForTest(supabase, input.batch_id, input.test_date, input.start_time, input.duration_minutes, testId)
    shifted = res.moved; unshiftable = res.unmoved
  }

  const { error } = await supabase.from('test_schedules').update(input).eq('id', testId)
  if (error) return { ok: false, error: error.message }

  await supabase.from('test_chapters').delete().eq('test_id', testId)
  if (input.part_type === 'Part' && chapterIds.length > 0) {
    const { error: cErr } = await supabase.from('test_chapters').insert(chapterIds.map((cid) => ({ test_id: testId, chapter_id: cid })))
    if (cErr) return { ok: false, error: cErr.message }
  }
  return { ok: true, shifted, unshiftable }
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

// --- Free faculty for a slot (for the invigilator dropdown) ---------------

/** Of the given candidate faculty, which ones are free (no weekly class, no
 *  planned lecture, no other test) at this exact date/time. */
export async function getFreeFacultyIds(
  supabase: SupabaseClient,
  args: { candidateFacultyIds: string[]; date: string; startTime: string; durationMinutes: number; ignoreTestId?: string }
): Promise<Set<string>> {
  if (args.candidateFacultyIds.length === 0) return new Set()
  const s = toMinutes(args.startTime.slice(0, 5))
  const e = s + args.durationMinutes
  const dow = new Date(args.date + 'T12:00:00').getDay()
  const busy = new Set<string>()

  const [wkRes, plRes, tsRes] = await Promise.all([
    supabase.from('batch_schedules').select('faculty_id, start_time, end_time').in('faculty_id', args.candidateFacultyIds).eq('day_of_week', dow),
    supabase.from('batch_planners').select('faculty_id, start_time, duration_minutes').in('faculty_id', args.candidateFacultyIds).eq('planned_date', args.date).not('start_time', 'is', null),
    (async () => {
      let q = supabase.from('test_schedules').select('faculty_id, start_time, duration_minutes').in('faculty_id', args.candidateFacultyIds).eq('test_date', args.date)
      if (args.ignoreTestId) q = q.neq('id', args.ignoreTestId)
      return q
    })(),
  ])
  for (const r of (wkRes.data ?? []) as { faculty_id: string | null; start_time: string; end_time: string }[]) {
    if (r.faculty_id && overlaps(s, e, toMinutes(r.start_time.slice(0, 5)), toMinutes(r.end_time.slice(0, 5)))) busy.add(r.faculty_id)
  }
  for (const r of (plRes.data ?? []) as { faculty_id: string | null; start_time: string; duration_minutes: number }[]) {
    if (r.faculty_id) { const rs = toMinutes(r.start_time.slice(0, 5)); if (overlaps(s, e, rs, rs + r.duration_minutes)) busy.add(r.faculty_id) }
  }
  for (const r of (tsRes.data ?? []) as { faculty_id: string | null; start_time: string; duration_minutes: number }[]) {
    if (r.faculty_id) { const rs = toMinutes(r.start_time.slice(0, 5)); if (overlaps(s, e, rs, rs + r.duration_minutes)) busy.add(r.faculty_id) }
  }
  return new Set(args.candidateFacultyIds.filter((id) => !busy.has(id)))
}

// --- Clash detail (what's actually there, for a readable message) --------

export type ClashingClass = { subject_name: string | null; topic_name: string; faculty_name: string | null; start_time: string; duration_minutes: number }

/** The specific class/lecture that clashes with a proposed test slot — used
 *  to show "There's a class X taught by Y at that time" instead of a generic
 *  message. Returns null if nothing clashes (or the clash is a weekly slot
 *  with no materialised lecture yet). */
export async function getClashingClass(
  supabase: SupabaseClient,
  args: { batchId: string; date: string; startTime: string; durationMinutes: number }
): Promise<ClashingClass | null> {
  const s = toMinutes(args.startTime.slice(0, 5))
  const e = s + args.durationMinutes
  const { data } = await supabase
    .from('batch_planners')
    .select('topic_name, start_time, duration_minutes, subjects(name), app_users(full_name)')
    .eq('batch_id', args.batchId).eq('planned_date', args.date).not('start_time', 'is', null)
  for (const r of (data ?? []) as { topic_name: string; start_time: string; duration_minutes: number; subjects: { name: string } | { name: string }[] | null; app_users: { full_name: string } | { full_name: string }[] | null }[]) {
    const rs = toMinutes(r.start_time.slice(0, 5))
    if (overlaps(s, e, rs, rs + r.duration_minutes)) {
      const subj = Array.isArray(r.subjects) ? r.subjects[0]?.name : r.subjects?.name
      const fac = Array.isArray(r.app_users) ? r.app_users[0]?.full_name : r.app_users?.full_name
      return { subject_name: subj ?? null, topic_name: r.topic_name, faculty_name: fac ?? null, start_time: r.start_time, duration_minutes: r.duration_minutes }
    }
  }
  return null
}

// --- Free room suggestions (when selected room is busy) ------------------

export type FreeClassroom = { id: string; name: string; room_no: string | null }

/** Find alternative classrooms at the same centre that are free at the test slot.
 *  Used to suggest room changes when the originally selected room is busy. */
export async function getFreeClassrooms(
  supabase: SupabaseClient,
  args: { centreId: string; date: string; startTime: string; durationMinutes: number; excludeRoomId?: string; ignoreTestId?: string }
): Promise<FreeClassroom[]> {
  // Get all active rooms at this centre
  const { data: rooms } = await supabase
    .from('classrooms')
    .select('id, name, room_no')
    .eq('centre_id', args.centreId)
    .eq('is_active', true)
    .order('room_no')
  
  if (!rooms || rooms.length === 0) return []
  
  const s = toMinutes(args.startTime.slice(0, 5))
  const e = s + args.durationMinutes
  const dow = new Date(args.date + 'T12:00:00').getDay()
  const busy = new Set<string>()
  
  // Check weekly schedules
  const { data: wk } = await supabase
    .from('batch_schedules')
    .select('classroom_id, start_time, end_time')
    .in('classroom_id', rooms.map(r => r.id))
    .eq('day_of_week', dow)
  
  for (const r of (wk ?? []) as { classroom_id: string | null; start_time: string; end_time: string }[]) {
    if (r.classroom_id && overlaps(s, e, toMinutes(r.start_time.slice(0, 5)), toMinutes(r.end_time.slice(0, 5)))) {
      busy.add(r.classroom_id)
    }
  }
  
  // Check planner lectures on that date
  const { data: pl } = await supabase
    .from('batch_planners')
    .select('classroom_id, start_time, duration_minutes')
    .in('classroom_id', rooms.map(r => r.id))
    .eq('planned_date', args.date)
    .not('start_time', 'is', null)
  
  for (const r of (pl ?? []) as { classroom_id: string | null; start_time: string; duration_minutes: number }[]) {
    if (r.classroom_id) {
      const rs = toMinutes(r.start_time.slice(0, 5))
      if (overlaps(s, e, rs, rs + r.duration_minutes)) busy.add(r.classroom_id)
    }
  }
  
  // Check other tests at that time
  let q = supabase
    .from('test_schedules')
    .select('classroom_id, start_time, duration_minutes')
    .in('classroom_id', rooms.map(r => r.id))
    .eq('test_date', args.date)
  
  if (args.ignoreTestId) q = q.neq('id', args.ignoreTestId)
  
  const { data: ts } = await q
  for (const r of (ts ?? []) as { classroom_id: string | null; start_time: string; duration_minutes: number }[]) {
    if (r.classroom_id) {
      const rs = toMinutes(r.start_time.slice(0, 5))
      if (overlaps(s, e, rs, rs + r.duration_minutes)) busy.add(r.classroom_id)
    }
  }
  
  // Return free rooms (excluding the originally selected one if specified)
  return (rooms as FreeClassroom[]).filter(r => 
    !busy.has(r.id) && (!args.excludeRoomId || r.id !== args.excludeRoomId)
  )
}

// --- Get tests for planner display ----------------------------------------

export type PlannerTest = {
  id: string
  name: string
  test_date: string
  start_time: string
  duration_minutes: number
  test_type: string
  part_type: string
  stage: string
  subject_id: string | null
  classroom_id: string | null
  faculty_id: string | null
}

/** Get all tests for a batch to display inline in the planner view. */
export async function getTestsForBatch(supabase: SupabaseClient, batchId: string): Promise<PlannerTest[]> {
  const { data } = await supabase
    .from('test_schedules')
    .select('id, name, test_date, start_time, duration_minutes, test_type, part_type, stage, subject_id, classroom_id, faculty_id')
    .eq('batch_id', batchId)
    .order('test_date')
    .order('start_time')
  
  return (data ?? []) as PlannerTest[]
}

// --- Comprehensive Batch Progress Tracking --------------------------------

export type BatchProgressStatus = 'on_track' | 'behind' | 'critically_behind' | 'ahead'

export type BatchProgressData = {
  batchId: string
  batchName: string
  startDate: string
  endDate: string
  totalDays: number
  elapsedDays: number
  remainingDays: number
  progressPercentage: number // Based on elapsed time (0-100%)
  
  // Lecture completion metrics
  totalLecturesPlanned: number
  lecturesCompleted: number
  lecturesExpected: number // How many should be done by now
  completionPercentage: number // Actual completion (0-100%)
  
  // Buffer analysis
  totalBufferSlots: number
  bufferSlotsUsed: number
  bufferSlotsRemaining: number
  bufferUtilizationPercentage: number
  
  // Status determination
  status: BatchProgressStatus
  statusMessage: string
  recommendations: string[]
  
  // Detailed breakdown by subject
  subjectProgress: Array<{
    subjectId: string
    subjectName: string
    plannedLectures: number
    completedLectures: number
    expectedLectures: number
    completionRate: number
    isOnTrack: boolean
  }>
}

/** Calculate comprehensive batch progress with schedule adherence analysis */
export async function getBatchProgress(
  supabase: SupabaseClient, 
  batchId: string
): Promise<BatchProgressData> {
  const today = new Date().toISOString().split('T')[0]
  
  // Get batch basic info
  const { data: batch } = await supabase
    .from('batches')
    .select('name, start_date, end_date')
    .eq('id', batchId)
    .single<{ name: string; start_date: string; end_date: string }>()
  
  if (!batch) {
    throw new Error('Batch not found')
  }
  
  const startDate = new Date(batch.start_date + 'T00:00:00')
  const endDate = new Date(batch.end_date + 'T00:00:00')
  const currentDate = new Date(today + 'T00:00:00')
  
  // Calculate time-based progress
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  const elapsedDays = Math.max(0, Math.ceil((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)))
  const remainingDays = Math.max(0, totalDays - elapsedDays)
  const progressPercentage = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100))
  
  // Get all planned lectures (non-buffer)
  const { data: plannedLectures } = await supabase
    .from('batch_planners')
    .select('subject_id, planned_date, status, is_buffer, subjects(name)')
    .eq('batch_id', batchId)
    .eq('is_buffer', false)
    .not('subject_id', 'is', null)
  
  const lectures = (plannedLectures ?? []) as unknown as Array<{
    subject_id: string
    planned_date: string
    status: string
    is_buffer: boolean
    subjects: any
  }>
  
  // Get buffer slots info
  const { data: bufferInfo } = await supabase
    .from('batch_planners')
    .select('is_buffer, shifted_for_test_id')
    .eq('batch_id', batchId)
    .eq('is_buffer', true)
  
  const buffers = (bufferInfo ?? []) as Array<{
    is_buffer: boolean
    shifted_for_test_id: string | null
  }>
  
  const totalBufferSlots = buffers.length
  const bufferSlotsUsed = buffers.filter(b => b.shifted_for_test_id !== null).length
  const bufferSlotsRemaining = totalBufferSlots - bufferSlotsUsed
  const bufferUtilizationPercentage = totalBufferSlots > 0 ? (bufferSlotsUsed / totalBufferSlots) * 100 : 0
  
  // Calculate lecture metrics
  const totalLecturesPlanned = lectures.length
  const lecturesCompleted = lectures.filter(l => l.status === 'conducted' || l.planned_date < today).length
  const lecturesExpected = Math.floor((progressPercentage / 100) * totalLecturesPlanned)
  const completionPercentage = totalLecturesPlanned > 0 ? (lecturesCompleted / totalLecturesPlanned) * 100 : 0
  
  // Subject-wise breakdown
  const subjectMap = new Map<string, {
    subjectId: string
    subjectName: string
    planned: Array<{ planned_date: string; status: string }>
  }>()
  
  lectures.forEach(l => {
    const id = l.subject_id
    const subjectData = Array.isArray(l.subjects) ? l.subjects[0] : l.subjects
    const name = subjectData?.name || 'Unknown Subject'
    if (!subjectMap.has(id)) {
      subjectMap.set(id, { subjectId: id, subjectName: name, planned: [] })
    }
    subjectMap.get(id)!.planned.push({ planned_date: l.planned_date, status: l.status })
  })
  
  const subjectProgress = Array.from(subjectMap.values()).map(s => {
    const plannedLectures = s.planned.length
    const completedLectures = s.planned.filter(p => p.status === 'conducted' || p.planned_date < today).length
    const expectedLectures = Math.floor((progressPercentage / 100) * plannedLectures)
    const completionRate = plannedLectures > 0 ? (completedLectures / plannedLectures) * 100 : 0
    const isOnTrack = completedLectures >= expectedLectures - 1 // Allow 1 lecture tolerance
    
    return {
      subjectId: s.subjectId,
      subjectName: s.subjectName,
      plannedLectures,
      completedLectures,
      expectedLectures,
      completionRate,
      isOnTrack
    }
  })
  
  // Determine overall status
  const lectureGap = lecturesExpected - lecturesCompleted
  let status: BatchProgressStatus = 'on_track'
  let statusMessage = ''
  const recommendations: string[] = []
  
  if (lectureGap <= 1) {
    status = 'on_track'
    statusMessage = `✅ On Track: ${lecturesCompleted}/${lecturesExpected} lectures completed as expected`
  } else if (lectureGap <= 3) {
    status = 'behind'
    statusMessage = `⚠️ Slightly Behind: ${lecturesCompleted}/${lecturesExpected} lectures completed (${lectureGap} behind)`
    recommendations.push(`Utilize ${Math.min(lectureGap, bufferSlotsRemaining)} buffer slots to catch up`)
    if (bufferSlotsRemaining < lectureGap) {
      recommendations.push('Consider rescheduling some lectures to weekends')
    }
  } else if (lectureGap > 3) {
    status = 'critically_behind'
    statusMessage = `🔴 Critically Behind: ${lecturesCompleted}/${lecturesExpected} lectures completed (${lectureGap} behind)`
    recommendations.push(`Immediately utilize all ${bufferSlotsRemaining} remaining buffer slots`)
    recommendations.push('Schedule additional weekend classes')
    recommendations.push('Review and potentially extend batch timeline')
  }
  
  if (lecturesCompleted > lecturesExpected + 2) {
    status = 'ahead'
    statusMessage = `🚀 Ahead of Schedule: ${lecturesCompleted}/${lecturesExpected} lectures completed`
    recommendations.push('Consider introducing additional practice sessions')
  }
  
  // Buffer warnings
  if (bufferUtilizationPercentage > 75) {
    recommendations.push(`⚠️ High buffer usage (${bufferSlotsUsed}/${totalBufferSlots} used)`)
  }
  
  return {
    batchId,
    batchName: batch.name,
    startDate: batch.start_date,
    endDate: batch.end_date,
    totalDays,
    elapsedDays,
    remainingDays,
    progressPercentage: Math.round(progressPercentage * 10) / 10,
    totalLecturesPlanned,
    lecturesCompleted,
    lecturesExpected,
    completionPercentage: Math.round(completionPercentage * 10) / 10,
    totalBufferSlots,
    bufferSlotsUsed,
    bufferSlotsRemaining,
    bufferUtilizationPercentage: Math.round(bufferUtilizationPercentage * 10) / 10,
    status,
    statusMessage,
    recommendations,
    subjectProgress
  }
}
// --- Undo a test's priority shift (called when the test is deleted) -------

/** Moves every lecture that was pushed forward for this test back to the date
 *  it held before — clearing the shift-tracking columns. Skips (and reports)
 *  any lecture whose original slot is now occupied by something else, rather
 *  than risk creating a new overlap — those can be fixed manually in Edit
 *  Planner. */
export async function revertTestShift(supabase: SupabaseClient, testId: string): Promise<{ reverted: number; skipped: number }> {
  const { data } = await supabase
    .from('batch_planners')
    .select('id, batch_id, subject_id, planned_date, shifted_from_date')
    .eq('shifted_for_test_id', testId)
  const rows = (data ?? []) as { id: string; batch_id: string; subject_id: string | null; planned_date: string; shifted_from_date: string | null }[]
  if (rows.length === 0) return { reverted: 0, skipped: 0 }

  const subjectIds = [...new Set(rows.map((r) => r.subject_id).filter((x): x is string => !!x))]
  const { data: schedRows } = subjectIds.length
    ? await supabase.from('batch_schedules').select('subject_id, day_of_week, start_time, end_time, classroom_id').in('subject_id', subjectIds)
    : { data: [] }
  const slotBySubjDay = new Map<string, { start: string; duration: number; classroom: string | null }>()
  for (const s of (schedRows ?? []) as { subject_id: string | null; day_of_week: number; start_time: string; end_time: string; classroom_id: string | null }[]) {
    if (!s.subject_id) continue
    const key = `${s.subject_id}:${s.day_of_week}`
    if (!slotBySubjDay.has(key)) slotBySubjDay.set(key, { start: s.start_time.slice(0, 5), duration: toMinutes(s.end_time.slice(0, 5)) - toMinutes(s.start_time.slice(0, 5)), classroom: s.classroom_id ?? null })
  }

  let reverted = 0, skipped = 0
  for (const r of rows) {
    if (!r.shifted_from_date) { skipped++; continue }
    const { count } = await supabase.from('batch_planners').select('id', { count: 'exact', head: true }).eq('batch_id', r.batch_id).eq('planned_date', r.shifted_from_date).neq('id', r.id)
    if ((count ?? 0) > 0) { skipped++; continue }
    const dow = new Date(r.shifted_from_date + 'T12:00:00').getDay()
    const slot = r.subject_id ? slotBySubjDay.get(`${r.subject_id}:${dow}`) : undefined
    const { error } = await supabase.from('batch_planners').update({
      planned_date: r.shifted_from_date, start_time: slot?.start ?? null, duration_minutes: slot?.duration ?? 60, classroom_id: slot?.classroom ?? null,
      shifted_for_test_id: null, shifted_from_date: null,
    }).eq('id', r.id)
    if (error) skipped++; else reverted++
  }
  return { reverted, skipped }
}