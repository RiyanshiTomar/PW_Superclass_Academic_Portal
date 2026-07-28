'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import {
  createTest, updateTest, setTestStage, getEligibleChapters, getTestCompletion, getBatchFreeWindows, validateTestSlot,
  type EligibleChapter, type TestInput, type TestCompletion, type FreeWindow,
} from '@/lib/tests'
import { stageBadgeClass, formatTime, toMinutes } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

// --- CSV parsing (quote-aware) --------------------------------------------
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQ = false
  const s = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else inQ = false }
      else cell += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// Normalise many date spellings to YYYY-MM-DD (ISO, DD/MM/YYYY, DD-MM-YYYY).
function normalizeDate(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) { const [, d, mo, y] = m; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}` }
  return null
}
function normalizeTime(raw: string): string | null {
  const v = raw.trim()
  const m = v.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}
const norm = (s: string) => s.toLowerCase().trim()

type BulkRow = {
  line: number
  raw: string[]
  batchId: string | null
  batchLabel: string
  subjectId: string | null
  scope: 'Full' | 'Part'
  name: string
  date: string | null
  time: string | null
  duration: number
  testType: string
  chapterIds: string[]
  facultyId: string | null
  classroomId: string | null
  errors: string[]
  status: 'error' | 'free' | 'shift'  // shift = class/lecture clash (planner shifts); error also covers test-vs-test clash
  clashNote: string | null
  completion: TestCompletion | null
}

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager'
type Batch = { id: string; name: string; centre_id: string; program_id: string; batch_manager_id: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type Subject = { id: string; name: string; program_id: string | null }
type Classroom = { id: string; name: string; room_no: string | null; centre_id: string; is_active: boolean }
type Faculty = { id: string; full_name: string; centre_id: string | null }
type UserCentre = { user_id: string; centre_id: string }
type TestRow = {
  id: string; batch_id: string; subject_id: string | null; classroom_id: string | null; faculty_id: string | null
  name: string; test_date: string; start_time: string; duration_minutes: number; test_type: string; part_type: string; stage: string
}
type TestChapterRow = { test_id: string; chapters: { name: string } | { name: string }[] | null }

function one<T>(v: T | T[] | null): T | null { return !v ? null : Array.isArray(v) ? v[0] ?? null : v }

export default function TestScheduler({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [userCentres, setUserCentres] = useState<UserCentre[]>([])
  const [tests, setTests] = useState<TestRow[]>([])
  const [testChapters, setTestChapters] = useState<TestChapterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Form
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [batchId, setBatchId] = useState('')
  const [name, setName] = useState('')
  const [testDate, setTestDate] = useState('')
  const [startTime, setStartTime] = useState('10:00')
  const [duration, setDuration] = useState('60')
  const [testType, setTestType] = useState('Objective')
  const [partType, setPartType] = useState('Full')
  const [subjectId, setSubjectId] = useState('')
  const [facultyId, setFacultyId] = useState('')
  const [classroomId, setClassroomId] = useState('')
  const [eligible, setEligible] = useState<EligibleChapter[]>([])
  const [loadingChapters, setLoadingChapters] = useState(false)
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  // Set when a save fails on a class/lecture clash → offer "test priority" shift.
  const [canShift, setCanShift] = useState(false)
  // Free windows suggested on the day when the picked slot clashes.
  const [freeWindows, setFreeWindows] = useState<FreeWindow[]>([])
  // Per-test aggregate syllabus completion (the ≥60% gate) — future tests only.
  const [completions, setCompletions] = useState<Record<string, TestCompletion>>({})
  // chapter ids per test (for the completion calc)
  const [chaptersByTest, setChaptersByTest] = useState<Record<string, string[]>>({})

  // Bulk CSV upload
  const [showBulk, setShowBulk] = useState(false)
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const isPrivileged = scope === 'central' || scope === 'admin'

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const au = user ? await getAppUser(supabase, user) : null
    setAppUser(au)
    const [bRes, cRes, sRes, clRes, fRes, ucRes, tRes] = await Promise.all([
      supabase.from('batches').select('id, name, centre_id, program_id, batch_manager_id').neq('status', 'Merged').order('name'),
      supabase.from('centres').select('id, name, branch_head_id').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
      supabase.from('classrooms').select('id, name, room_no, centre_id, is_active').order('room_no'),
      supabase.rpc('list_active_faculty', { p_centre_id: null }),
      supabase.from('user_centres').select('user_id, centre_id'),
      supabase.from('test_schedules').select('id, batch_id, subject_id, classroom_id, faculty_id, name, test_date, start_time, duration_minutes, test_type, part_type, stage').order('test_date', { ascending: false }),
    ])
    if (bRes.data) setBatches(bRes.data as Batch[])
    if (cRes.data) setCentres(cRes.data as Centre[])
    if (sRes.data) setSubjects(sRes.data as Subject[])
    if (clRes.data) setClassrooms(clRes.data as Classroom[])
    if (fRes.data) setFaculty(Array.from(new Map((fRes.data as Faculty[]).map((f) => [f.id, f])).values()))
    if (ucRes.data) setUserCentres(ucRes.data as UserCentre[])
    if (tRes.data) {
      setTests(tRes.data as TestRow[])
      const ids = (tRes.data as TestRow[]).map((t) => t.id)
      if (ids.length) {
        const { data: tc } = await supabase.from('test_chapters').select('test_id, chapter_id, chapters(name)').in('test_id', ids)
        const rows = (tc ?? []) as unknown as (TestChapterRow & { chapter_id: string })[]
        setTestChapters(rows as TestChapterRow[])
        const map: Record<string, string[]> = {}
        for (const r of rows) { (map[r.test_id] ??= []).push(r.chapter_id) }
        setChaptersByTest(map)
      } else { setTestChapters([]); setChaptersByTest({}) }
    }
    setLoading(false)
  }

  useEffect(() => { loadData(); /* eslint-disable-next-line */ }, [])

  // ---- Scoping -------------------------------------------------------------
  const allowedCentreIds = useMemo(() => {
    if (isPrivileged) return new Set(centres.map((c) => c.id))
    const set = new Set<string>(getUserCentreIds(appUser))
    if (scope === 'branch' && appUser) centres.filter((c) => c.branch_head_id === appUser.id).forEach((c) => set.add(c.id))
    return set
  }, [appUser, centres, isPrivileged, scope])

  const visibleBatches = useMemo(() => {
    if (isPrivileged) return batches
    if (scope === 'batch-manager' && appUser) return batches.filter((b) => b.batch_manager_id === appUser.id)
    return batches.filter((b) => allowedCentreIds.has(b.centre_id))
  }, [batches, isPrivileged, scope, appUser, allowedCentreIds])

  const visibleBatchIds = useMemo(() => new Set(visibleBatches.map((b) => b.id)), [visibleBatches])
  const visibleTests = useMemo(() => tests.filter((t) => visibleBatchIds.has(t.batch_id)), [tests, visibleBatchIds])

  // ---- Form derived --------------------------------------------------------
  const formBatch = batches.find((b) => b.id === batchId) ?? null
  const centreFacultyIds = useMemo(() => {
    if (!formBatch) return new Set<string>()
    return new Set(userCentres.filter((uc) => uc.centre_id === formBatch.centre_id).map((uc) => uc.user_id))
  }, [userCentres, formBatch])
  const formFaculty = useMemo(
    () => (formBatch ? faculty.filter((f) => centreFacultyIds.has(f.id) || f.centre_id === formBatch.centre_id) : []),
    [faculty, formBatch, centreFacultyIds]
  )
  const formRooms = useMemo(
    () => (formBatch ? classrooms.filter((c) => c.centre_id === formBatch.centre_id && c.is_active) : []),
    [classrooms, formBatch]
  )
  const formSubjects = useMemo(
    () => (formBatch ? subjects.filter((s) => s.program_id === formBatch.program_id) : []),
    [subjects, formBatch]
  )

  // Load the subject's chapters (with a % taught hint). All are selectable —
  // central schedules a year ahead; the ≥60% check happens later via alerts.
  useEffect(() => {
    if (partType !== 'Part' || !batchId || !subjectId) { setEligible([]); return }
    let cancelled = false
    setLoadingChapters(true)
    const byDate = testDate || new Date().toISOString().split('T')[0]
    getEligibleChapters(supabase, { batchId, subjectId, byDate }).then((rows) => {
      if (!cancelled) { setEligible(rows); setLoadingChapters(false) }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partType, batchId, subjectId, testDate])

  // Compute the ≥60% syllabus gate for every upcoming test so we can warn on
  // the card. Only future tests matter (past ones already happened).
  useEffect(() => {
    if (visibleTests.length === 0) { setCompletions({}); return }
    let cancelled = false
    const today = new Date().toISOString().split('T')[0]
    const upcoming = visibleTests.filter((t) => t.test_date >= today)
    ;(async () => {
      const out: Record<string, TestCompletion> = {}
      for (const t of upcoming) {
        const b = batches.find((x) => x.id === t.batch_id)
        const comp = await getTestCompletion(supabase, {
          batchId: t.batch_id,
          byDate: t.test_date,
          partType: t.part_type,
          subjectId: t.subject_id,
          chapterIds: chaptersByTest[t.id] ?? [],
          programId: b?.program_id ?? null,
        })
        if (cancelled) return
        out[t.id] = comp
      }
      if (!cancelled) setCompletions(out)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tests, chaptersByTest, visibleBatchIds])

  const batchLabel = (b: Batch) => `${b.name} — ${centres.find((c) => c.id === b.centre_id)?.name ?? ''}`
  const roomLabel = (c: Classroom) => (c.room_no ? `${c.room_no} · ${c.name}` : c.name)
  const testChapterNames = (testId: string) =>
    testChapters.filter((tc) => tc.test_id === testId).map((tc) => one(tc.chapters)?.name).filter(Boolean) as string[]

  const resetForm = () => {
    setShowForm(false); setEditingId(null)
    setBatchId(''); setName(''); setTestDate(''); setStartTime('10:00'); setDuration('60')
    setTestType('Objective'); setPartType('Full'); setSubjectId(''); setFacultyId(''); setClassroomId('')
    setEligible([]); setSelectedChapters(new Set()); setCanShift(false); setFreeWindows([])
  }

  const startEdit = (t: TestRow) => {
    setEditingId(t.id); setShowForm(true); setMsg(null)
    setBatchId(t.batch_id); setName(t.name); setTestDate(t.test_date); setStartTime(t.start_time.slice(0, 5))
    setDuration(String(t.duration_minutes)); setTestType(t.test_type); setPartType(t.part_type)
    setSubjectId(t.subject_id ?? ''); setFacultyId(t.faculty_id ?? ''); setClassroomId(t.classroom_id ?? '')
    setSelectedChapters(new Set(testChapters.filter((tc) => tc.test_id === t.id).map(() => '').filter(Boolean))) // reset; reload below
    supabase.from('test_chapters').select('chapter_id').eq('test_id', t.id).then(({ data }) => {
      setSelectedChapters(new Set((data ?? []).map((r) => r.chapter_id as string)))
    })
  }

  const toggleChapter = (id: string) => {
    setSelectedChapters((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const submit = (e: React.FormEvent) => { e.preventDefault(); doSubmit(false) }

  const doSubmit = async (testPriority: boolean) => {
    setMsg(null); setCanShift(false); setFreeWindows([])
    if (!batchId) return setMsg({ type: 'error', text: 'Pick a batch.' })
    if (!name.trim()) return setMsg({ type: 'error', text: 'Give the test a name.' })
    if (!testDate) return setMsg({ type: 'error', text: 'Pick a test date.' })
    const dur = parseInt(duration, 10)
    if (!dur || dur < 15 || dur > 480) return setMsg({ type: 'error', text: 'Duration must be 15–480 minutes.' })
    // Invigilator is optional — can be assigned later.
    if (!classroomId) return setMsg({ type: 'error', text: 'Pick a room.' })
    let chapterIds: string[] = []
    if (partType === 'Part') {
      if (!subjectId) return setMsg({ type: 'error', text: 'Pick a subject for the part test.' })
      chapterIds = [...selectedChapters]
      if (chapterIds.length === 0) return setMsg({ type: 'error', text: 'Select at least one chapter for the part test.' })
    }

    setSaving(true)
    const input: TestInput = {
      batch_id: batchId,
      subject_id: partType === 'Part' ? subjectId : null,
      classroom_id: classroomId,
      faculty_id: facultyId || null,
      name: name.trim(),
      test_date: testDate,
      start_time: startTime,
      duration_minutes: dur,
      test_type: testType,
      part_type: partType,
      created_by: appUser?.id ?? null,
    }
    const res = editingId ? await updateTest(supabase, editingId, input, chapterIds, { testPriority }) : await createTest(supabase, input, chapterIds, { testPriority })
    setSaving(false)
    if (!res.ok) {
      setMsg({ type: 'error', text: res.error ?? 'Could not save the test.' })
      // A class/lecture clash can be resolved by giving the test priority; a
      // clash with another TEST cannot, so only offer the shift for the former.
      setCanShift(!testPriority && /class|planned lecture/i.test(res.error ?? ''))
      // Whatever the clash, show the day's free windows so central can move it.
      const fw = await getBatchFreeWindows(supabase, { batchId, date: testDate, durationMinutes: dur, ignoreTestId: editingId ?? undefined })
      setFreeWindows(fw)
      return
    }
    const shiftNote = res.shifted ? ` ${res.shifted} clashing lecture(s) shifted forward.` : ''
    setMsg({ type: 'success', text: (editingId ? 'Test updated (saved as draft).' : 'Test saved as draft. Use “Send to Faculty” to assign.') + shiftNote })
    resetForm()
    await loadData()
  }

  const changeStage = async (t: TestRow, stage: string) => {
    setBusyId(t.id); setMsg(null)
    const { error } = await setTestStage(supabase, t.id, stage)
    setBusyId(null)
    if (error) return setMsg({ type: 'error', text: error })
    setMsg({ type: 'success', text: `Test ${stage === 'Faculty Assigned' ? 'sent to faculty' : `moved to ${stage}`}.` })
    await loadData()
  }

  const deleteTest = async (t: TestRow) => {
    if (!confirm(`Delete test "${t.name}"? This cannot be undone.`)) return
    setBusyId(t.id)
    const { error } = await supabase.from('test_schedules').delete().eq('id', t.id)
    setBusyId(null)
    if (error) return setMsg({ type: 'error', text: error.message })
    await loadData()
  }

  // ---- Bulk CSV upload -----------------------------------------------------
  const downloadBulkTemplate = () => {
    const headers = ['Batch', 'Subject', 'Test Name', 'Date', 'Time', 'Duration', 'Type', 'Scope', 'Chapters', 'Room', 'Invigilator Email']
    const example = ['(exact batch name)', '(blank = Full syllabus)', 'Weekly Test 3', '2026-08-15', '10:00', '60', 'Objective', 'Full', 'Chapter A; Chapter B', '(optional room no)', '(optional) faculty@pw.live']
    const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)
    const csv = [headers.join(','), example.map(esc).join(',')].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = 'test-upload-template.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const colIndex = (headers: string[], aliases: string[]) => {
    const h = headers.map((x) => x.toLowerCase().trim())
    for (const a of aliases) { const i = h.indexOf(a); if (i >= 0) return i }
    return -1
  }

  const chapterCache = useMemo(() => new Map<string, { id: string; name: string }[]>(), [])
  const chaptersOfSubject = async (sid: string) => {
    if (chapterCache.has(sid)) return chapterCache.get(sid)!
    const { data } = await supabase.from('chapters').select('id, name').eq('subject_id', sid)
    const rows = (data ?? []) as { id: string; name: string }[]
    chapterCache.set(sid, rows)
    return rows
  }
  const pickFreeRoom = async (rooms: Classroom[], date: string, time: string, dur: number): Promise<string | null> => {
    if (!rooms.length) return null
    const s = toMinutes(time), e = s + dur
    const { data } = await supabase.from('test_schedules').select('classroom_id, start_time, duration_minutes').eq('test_date', date).in('classroom_id', rooms.map((r) => r.id))
    const busy = new Set<string>()
    for (const r of (data ?? []) as { classroom_id: string | null; start_time: string; duration_minutes: number }[]) {
      const rs = toMinutes(r.start_time.slice(0, 5))
      if (r.classroom_id && rs < e && rs + r.duration_minutes > s) busy.add(r.classroom_id)
    }
    return rooms.find((r) => !busy.has(r.id))?.id ?? rooms[0]?.id ?? null
  }

  const parseBulk = async (text: string) => {
    setBulkMsg(null); setBulkRows([])
    const raw = parseCsvRows(text)
    if (raw.length < 2) { setBulkMsg({ type: 'error', text: 'The CSV needs a header row and at least one test row.' }); return }
    const headers = raw[0]
    const ci = {
      batch: colIndex(headers, ['batch']),
      subject: colIndex(headers, ['subject']),
      name: colIndex(headers, ['test name', 'name']),
      date: colIndex(headers, ['date', 'test date']),
      time: colIndex(headers, ['time', 'start time']),
      duration: colIndex(headers, ['duration', 'duration (min)', 'duration(min)', 'minutes']),
      type: colIndex(headers, ['type', 'test type']),
      scope: colIndex(headers, ['scope', 'part type', 'part']),
      chapters: colIndex(headers, ['chapters', 'chapter']),
      room: colIndex(headers, ['room', 'room no', 'classroom']),
      invig: colIndex(headers, ['invigilator email', 'invigilator', 'faculty email', 'faculty']),
    }
    if (ci.batch < 0 || ci.name < 0 || ci.date < 0) {
      setBulkMsg({ type: 'error', text: 'CSV must have at least Batch, Test Name and Date columns. Download the template.' }); return
    }
    setBulkBusy(true)
    const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : '')
    const dataRows = raw.slice(1)

    // Resolve invigilator emails once.
    const emails = [...new Set(dataRows.map((r) => get(r, ci.invig).toLowerCase()).filter(Boolean))]
    const emailToId = new Map<string, string>()
    if (emails.length) {
      const { data } = await supabase.from('app_users').select('id, email').in('email', emails)
      for (const u of (data ?? []) as { id: string; email: string | null }[]) if (u.email) emailToId.set(u.email.toLowerCase(), u.id)
    }

    const out: BulkRow[] = []
    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const errors: string[] = []

      // Batch
      const bc = norm(get(r, ci.batch))
      let cand = visibleBatches.filter((b) => norm(b.name) === bc)
      if (cand.length !== 1) { const full = visibleBatches.filter((b) => norm(batchLabel(b)) === bc); if (full.length === 1) cand = full }
      if (cand.length === 0) errors.push('Batch not found (must match exactly).')
      else if (cand.length > 1) errors.push('Batch is ambiguous — write it as "Name — Centre".')
      const batch = cand.length === 1 ? cand[0] : null

      // Scope + subject
      const subjectCell = get(r, ci.subject)
      const scopeCell = norm(get(r, ci.scope))
      const scope: 'Full' | 'Part' = scopeCell.startsWith('part') ? 'Part' : scopeCell.startsWith('full') ? 'Full' : (subjectCell ? 'Part' : 'Full')
      let subjectId: string | null = null
      if (scope === 'Part') {
        if (!subjectCell) errors.push('Part test needs a Subject.')
        else if (batch) {
          const subs = subjects.filter((s) => s.program_id === batch.program_id && norm(s.name) === norm(subjectCell))
          if (subs.length === 1) subjectId = subs[0].id
          else errors.push(`Subject "${subjectCell}" not found in the batch’s program.`)
        }
      }

      // Chapters (Part only)
      let chapterIds: string[] = []
      if (scope === 'Part' && subjectId) {
        const names = get(r, ci.chapters).split(';').map((x) => x.trim()).filter(Boolean)
        if (names.length === 0) errors.push('Part test needs at least one chapter.')
        else {
          const chs = await chaptersOfSubject(subjectId)
          const missing: string[] = []
          for (const nm of names) { const c = chs.find((x) => norm(x.name) === norm(nm)); if (c) chapterIds.push(c.id); else missing.push(nm) }
          if (missing.length) errors.push(`Chapters not found: ${missing.join(', ')}.`)
        }
      }

      // Date / time / duration / type / name
      const date = normalizeDate(get(r, ci.date)); if (!date) errors.push('Bad or missing date (use YYYY-MM-DD).')
      const time = normalizeTime(get(r, ci.time)) ?? '10:00'
      const dur = parseInt(get(r, ci.duration), 10) || 60; if (dur < 15 || dur > 480) errors.push('Duration must be 15–480 minutes.')
      const name = get(r, ci.name); if (!name) errors.push('Missing test name.')
      const testType = /subj/i.test(get(r, ci.type)) ? 'Subjective' : 'Objective'

      // Room (explicit or auto-pick a free one at the centre)
      let classroomId: string | null = null
      if (batch && date) {
        const centreRooms = classrooms.filter((c) => c.centre_id === batch.centre_id && c.is_active)
        const roomCell = get(r, ci.room)
        if (roomCell && !/^\(/.test(roomCell)) {
          const rm = centreRooms.filter((c) => norm(c.room_no ?? '') === norm(roomCell) || norm(c.name) === norm(roomCell))
          if (rm.length >= 1) classroomId = rm[0].id
          else errors.push(`Room "${roomCell}" not found at the batch’s centre.`)
        } else {
          classroomId = await pickFreeRoom(centreRooms, date, time, dur)
        }
      }

      // Invigilator
      let facultyId: string | null = null
      const invigCell = norm(get(r, ci.invig))
      if (invigCell && !/^\(/.test(invigCell)) { const id = emailToId.get(invigCell); if (id) facultyId = id; else errors.push('Invigilator email not found.') }

      // Clash + completion
      let status: BulkRow['status'] = errors.length ? 'error' : 'free'
      let clashNote: string | null = null
      let completion: TestCompletion | null = null
      if (!errors.length && batch && date) {
        const slot = { batchId: batch.id, facultyId, classroomId, date, startTime: time, durationMinutes: dur }
        const priClash = await validateTestSlot(supabase, slot, { testPriority: true })
        if (priClash) { status = 'error'; clashNote = priClash + ' (can’t auto-shift another test — fix the time).' }
        else { const noPri = await validateTestSlot(supabase, slot); if (noPri) { status = 'shift'; clashNote = noPri } }
        completion = await getTestCompletion(supabase, { batchId: batch.id, byDate: date, partType: scope, subjectId, chapterIds, programId: batch.program_id })
      }

      out.push({
        line: idx + 2, raw: r, batchId: batch?.id ?? null, batchLabel: batch ? batchLabel(batch) : get(r, ci.batch),
        subjectId, scope, name, date, time, duration: dur, testType, chapterIds, facultyId, classroomId, errors, status, clashNote, completion,
      })
    }
    setBulkRows(out)
    setBulkBusy(false)
    const ok = out.filter((x) => x.status !== 'error').length
    setBulkMsg({ type: ok ? 'info' : 'error', text: `${out.length} row(s) read · ${ok} ready to import · ${out.length - ok} need fixing.` })
  }

  const onBulkFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const text = await f.text()
    e.target.value = ''
    await parseBulk(text)
  }

  const importBulk = async () => {
    const rows = bulkRows.filter((x) => x.status !== 'error')
    if (rows.length === 0) { setBulkMsg({ type: 'error', text: 'Nothing to import — every row has an error.' }); return }
    setBulkBusy(true)
    let ok = 0, shifted = 0
    const failures: string[] = []
    for (const row of rows) {
      const inp: TestInput = {
        batch_id: row.batchId!, subject_id: row.scope === 'Part' ? row.subjectId : null, classroom_id: row.classroomId ?? null,
        faculty_id: row.facultyId, name: row.name, test_date: row.date!, start_time: row.time!, duration_minutes: row.duration,
        test_type: row.testType, part_type: row.scope, created_by: appUser?.id ?? null,
      }
      // Tests take priority — any class/lecture clash shifts the planner forward.
      const res = await createTest(supabase, inp, row.chapterIds, { testPriority: true })
      if (res.ok) { ok++; shifted += res.shifted ?? 0 } else failures.push(`Line ${row.line} (${row.name}): ${res.error}`)
    }
    setBulkBusy(false)
    setBulkRows([])
    const warns = rows.filter((r) => r.completion?.warn).length
    setBulkMsg({
      type: failures.length ? 'error' : 'success',
      text: `Imported ${ok} test(s) as draft${shifted ? `, ${shifted} clashing lecture(s) shifted forward` : ''}.` +
        (warns ? ` ${warns} have <60% syllabus taught — see the warnings in the list.` : '') +
        (failures.length ? ` Failed: ${failures.join('; ')}` : ''),
    })
    await loadData()
  }

  const input = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const subjName = (id: string | null) => subjects.find((s) => s.id === id)?.name
  const facName = (id: string | null) => faculty.find((f) => f.id === id)?.full_name
  const roomName = (id: string | null) => { const c = classrooms.find((x) => x.id === id); return c ? roomLabel(c) : null }
  const batchName = (id: string) => batches.find((b) => b.id === id)?.name ?? 'Batch'

  return (
    <div>
      <PageHeader
        title="Test Scheduler"
        description={isPrivileged
          ? 'Schedule batch tests (a whole year ahead if you like). Validated against the batch’s classes, room and faculty — nothing overlaps. Pick any chapters for part tests; the % is just a coverage hint.'
          : 'Tests for your batches, by stage. Central Team schedules; faculty confirm.'}
        action={isPrivileged && !showForm ? (
          <div className="flex flex-wrap gap-2">
            <BtnSecondary onClick={() => { setShowBulk((v) => !v); setBulkMsg(null); setBulkRows([]) }}>{showBulk ? 'Close upload' : '⬆ Upload CSV'}</BtnSecondary>
            <BtnPrimary onClick={() => { resetForm(); setShowForm(true) }}>+ Schedule Test</BtnPrimary>
          </div>
        ) : undefined}
      />

      {msg && <Alert type={msg.type === 'info' ? 'info' : msg.type}>{msg.text}</Alert>}

      {isPrivileged && showBulk && (
        <Card className="p-6 mb-8">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <div>
              <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider">Bulk upload tests</h3>
              <p className="text-xs text-neutral-500 mt-1 max-w-2xl">
                Columns: <span className="font-medium">Batch · Subject (blank = Full) · Test Name · Date · Time · Duration · Type · Scope · Chapters (“;”-separated) · Room (optional) · Invigilator Email (optional)</span>.
                Tests take priority — if a row lands on a class, the planner is shifted forward automatically. A row that clashes with <em>another test</em> can’t be imported. Rooms are auto-assigned when left blank.
              </p>
            </div>
            <BtnSecondary onClick={downloadBulkTemplate}>Download template</BtnSecondary>
          </div>
          <label className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-950 hover:bg-neutral-800 text-white text-sm font-semibold rounded-xl cursor-pointer">
            {bulkBusy ? 'Reading…' : 'Choose CSV file'}
            <input type="file" accept=".csv,text/csv" onChange={onBulkFile} disabled={bulkBusy} className="hidden" />
          </label>
          {bulkMsg && <div className="mt-3"><Alert type={bulkMsg.type === 'info' ? 'info' : bulkMsg.type}>{bulkMsg.text}</Alert></div>}

          {bulkRows.length > 0 && (
            <div className="mt-4">
              <div className="overflow-x-auto border border-neutral-200 rounded-xl">
                <table className="w-full text-xs">
                  <thead className="bg-neutral-50 text-neutral-500 uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">#</th>
                      <th className="text-left px-3 py-2 font-semibold">Test</th>
                      <th className="text-left px-3 py-2 font-semibold">Batch</th>
                      <th className="text-left px-3 py-2 font-semibold">When</th>
                      <th className="text-left px-3 py-2 font-semibold">Scope</th>
                      <th className="text-left px-3 py-2 font-semibold">Syllabus</th>
                      <th className="text-left px-3 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {bulkRows.map((r) => (
                      <tr key={r.line} className={r.status === 'error' ? 'bg-red-50/40' : ''}>
                        <td className="px-3 py-2 text-neutral-400">{r.line}</td>
                        <td className="px-3 py-2 font-medium text-neutral-800">{r.name || <span className="text-neutral-400">—</span>}<span className="ml-1 text-neutral-400">{r.testType}</span></td>
                        <td className="px-3 py-2 text-neutral-600">{r.batchLabel}</td>
                        <td className="px-3 py-2 text-neutral-600">{r.date ? `${r.date} ${r.time}` : <span className="text-red-500">no date</span>} · {r.duration}m</td>
                        <td className="px-3 py-2 text-neutral-600">{r.scope}{r.scope === 'Part' && r.chapterIds.length ? ` · ${r.chapterIds.length} ch` : ''}</td>
                        <td className="px-3 py-2">
                          {r.completion?.hasData
                            ? <span className={`font-bold ${r.completion.warn ? 'text-red-600' : 'text-emerald-600'}`}>{r.completion.pct}%{r.completion.warn ? ' ⚠' : ''}</span>
                            : <span className="text-neutral-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.status === 'error'
                            ? <span className="text-red-600 font-semibold">✕ {r.errors[0] ?? r.clashNote}</span>
                            : r.status === 'shift'
                              ? <span className="text-amber-600 font-semibold" title={r.clashNote ?? ''}>⚠ will shift planner</span>
                              : <span className="text-emerald-600 font-semibold">✓ free</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <BtnPrimary onClick={importBulk} disabled={bulkBusy || bulkRows.every((r) => r.status === 'error')}>
                  {bulkBusy ? 'Importing…' : `Import ${bulkRows.filter((r) => r.status !== 'error').length} test(s)`}
                </BtnPrimary>
                <BtnSecondary onClick={() => { setBulkRows([]); setBulkMsg(null) }}>Clear</BtnSecondary>
                <span className="text-xs text-neutral-400">Rows with ✕ are skipped. Tests import as Draft — use “Send to Faculty” after.</span>
              </div>
            </div>
          )}
        </Card>
      )}

      {isPrivileged && showForm && (
        <Card className="p-6 mb-8">
          <form onSubmit={submit}>
            <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider mb-4">{editingId ? 'Edit Test' : 'New Test'}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Batch *</label>
                <select value={batchId} onChange={(e) => { setBatchId(e.target.value); setFacultyId(''); setClassroomId(''); setSubjectId(''); setSelectedChapters(new Set()) }} className={input} disabled={!!editingId}>
                  <option value="">Select batch</option>
                  {visibleBatches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Test Name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly Test 3" className={input} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Date *</label>
                <input type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} className={input} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Start Time *</label>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={input} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Duration (min) *</label>
                <input type="number" min={15} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} className={input} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Test Type *</label>
                <select value={testType} onChange={(e) => setTestType(e.target.value)} className={input}>
                  <option>Objective</option>
                  <option>Subjective</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Part Type *</label>
                <select value={partType} onChange={(e) => { setPartType(e.target.value); setSelectedChapters(new Set()) }} className={input}>
                  <option value="Full">Full syllabus</option>
                  <option value="Part">Part (choose chapters)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Faculty (invigilator)</label>
                <select value={facultyId} onChange={(e) => setFacultyId(e.target.value)} className={input} disabled={!formBatch}>
                  <option value="">{formBatch ? 'Unassigned (optional)' : 'Pick batch first'}</option>
                  {formFaculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Room *</label>
                <select value={classroomId} onChange={(e) => setClassroomId(e.target.value)} className={input} disabled={!formBatch}>
                  <option value="">{formBatch ? (formRooms.length ? 'Select room' : 'No rooms at centre') : 'Pick batch first'}</option>
                  {formRooms.map((c) => <option key={c.id} value={c.id}>{roomLabel(c)}</option>)}
                </select>
              </div>
            </div>

            {partType === 'Part' && (
              <div className="mb-4">
                <div className="mb-2">
                  <label className="block text-xs font-medium text-neutral-500 mb-1">Subject *</label>
                  <select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setSelectedChapters(new Set()) }} className={`${input} md:w-1/3`} disabled={!formBatch}>
                    <option value="">Select subject</option>
                    {formSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="border border-neutral-200 rounded-xl p-4 bg-neutral-50/50">
                  <p className="text-xs font-semibold text-neutral-600 mb-2">Chapters — pick the ones this test covers. The % is how much is taught by the test date (just a hint; we&apos;ll alert you later if it stays below 60%).</p>
                  {!subjectId ? (
                    <p className="text-xs text-neutral-400">Pick a subject to load chapters.</p>
                  ) : loadingChapters ? (
                    <p className="text-xs text-neutral-400">Loading chapters…</p>
                  ) : eligible.length === 0 ? (
                    <p className="text-xs text-neutral-400">No chapters found for this subject in the syllabus master.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {eligible.map((c) => (
                        <label key={c.chapter_id} className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-neutral-200 cursor-pointer hover:border-violet-300 text-sm">
                          <input type="checkbox" checked={selectedChapters.has(c.chapter_id)} onChange={() => toggleChapter(c.chapter_id)} />
                          <span className="flex-1">{c.name}</span>
                          <span className={`text-[11px] font-bold ${c.pct >= 60 ? 'text-emerald-600' : 'text-amber-500'}`}>{c.pct}%{c.topics_total > 0 ? ` · ${c.topics_covered}/${c.topics_total}` : ''}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <BtnPrimary type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save Changes' : 'Save as Draft'}</BtnPrimary>
              {canShift && (
                <button type="button" onClick={() => doSubmit(true)} disabled={saving} className="h-10 px-5 bg-amber-500 hover:bg-amber-600 disabled:bg-neutral-300 text-white rounded-xl text-sm font-semibold">
                  {saving ? 'Working…' : 'Give test priority → shift planner forward'}
                </button>
              )}
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
            {canShift && <p className="mt-2 text-xs text-amber-700">There&rsquo;s a class at this time. This will push that class (and its subject&rsquo;s later lectures) one class-date forward and place the test here.</p>}
            {freeWindows.length > 0 && (
              <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                <p className="text-xs font-semibold text-emerald-800 mb-2">Free slots for this batch on {testDate ? new Date(testDate + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'that day'} — click to use one:</p>
                <div className="flex flex-wrap gap-2">
                  {freeWindows.map((w) => (
                    <button key={w.start} type="button" onClick={() => { setStartTime(w.start); setMsg(null); setCanShift(false); setFreeWindows([]) }}
                      className="px-3 py-1.5 bg-white border border-emerald-300 text-emerald-800 text-xs font-semibold rounded-lg hover:bg-emerald-100">
                      {formatTime(w.start)} – {formatTime(w.end)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {canShift && freeWindows.length === 0 && <p className="mt-2 text-xs text-neutral-500">No free window long enough on this day — either shift the planner (above) or pick another date.</p>}
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : visibleTests.length === 0 ? (
        <Card className="p-10 text-center text-neutral-400">No tests scheduled yet.</Card>
      ) : (
        <div className="space-y-3">
          {(() => {
            const warns = visibleTests.filter((t) => completions[t.id]?.warn)
            return warns.length > 0 ? (
              <Alert type="error">
                {warns.length} upcoming test{warns.length > 1 ? 's have' : ' has'} less than 60% of the syllabus taught by the test date. Edit the test (chapters/date) or push the planner so the syllabus catches up.
              </Alert>
            ) : null
          })()}
          {visibleTests.map((t) => {
            const chNames = testChapterNames(t.id)
            const comp = completions[t.id]
            return (
              <Card key={t.id} className={`p-4 ${comp?.warn ? 'ring-1 ring-red-200' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-neutral-950">{t.name || 'Test'}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(t.stage)}`}>{t.stage}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{t.test_type}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">{t.part_type === 'Full' ? 'Full syllabus' : 'Part'}</span>
                      {comp?.hasData && (
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${comp.warn ? 'bg-red-100 text-red-700 ring-1 ring-red-200' : 'bg-emerald-50 text-emerald-700'}`}>
                          {comp.warn ? `⚠ Syllabus ${comp.pct}%` : `Syllabus ${comp.pct}%`}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-neutral-700 mt-1">{batchName(t.batch_id)} · {new Date(t.test_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · {formatTime(t.start_time)} · {t.duration_minutes}m</p>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {roomName(t.classroom_id) ?? 'No room'} · {facName(t.faculty_id) ?? 'No faculty'}
                      {t.part_type === 'Part' && t.subject_id ? ` · ${subjName(t.subject_id) ?? ''}` : ''}
                    </p>
                    {t.part_type === 'Part' && chNames.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {chNames.map((n) => <span key={n} className="text-[11px] bg-violet-50 text-violet-700 border border-violet-100 rounded px-2 py-0.5">{n}</span>)}
                      </div>
                    )}
                  </div>
                  {isPrivileged && (
                    <div className="flex flex-wrap items-center gap-2">
                      {(t.stage === 'Draft' || t.stage === 'Rework') && (
                        <button onClick={() => changeStage(t, 'Faculty Assigned')} disabled={busyId === t.id} className="px-3 py-1.5 bg-neutral-950 hover:bg-neutral-800 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Send to Faculty</button>
                      )}
                      {t.stage === 'Faculty Assigned' && (
                        <button onClick={() => changeStage(t, 'Rework')} disabled={busyId === t.id} className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Recall / Rework</button>
                      )}
                      {t.stage !== 'Confirmed' && (
                        <button onClick={() => startEdit(t)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">Edit</button>
                      )}
                      <button onClick={() => deleteTest(t)} disabled={busyId === t.id} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-xs font-semibold rounded-lg">Delete</button>
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
