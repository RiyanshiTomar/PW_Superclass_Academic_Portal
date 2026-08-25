'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import {
  createTest, updateTest, setTestStage, getEligibleChapters, getTestCompletion, getBatchFreeWindows, validateTestSlot,
  getFreeFacultyIds, getClashingClass, getFreeClassrooms, revertTestShift, type ClashingClass,
  type EligibleChapter, type TestInput, type TestCompletion, type FreeWindow, type FreeClassroom,
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
  batchIds: string[]  // Add support for multiple batches
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
  roomAutoAssigned: boolean  // true if room was auto-picked (not in CSV)
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
type Faculty = { id: string; full_name: string; centre_id: string | null; faculty_type: string | null }
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
  const [testBatchMappings, setTestBatchMappings] = useState<Record<string, string[]>>({}) // test_id -> batch_ids[]
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Form
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [batchId, setBatchId] = useState('')
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set())
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
  const [freeFacultyIds, setFreeFacultyIds] = useState<Set<string> | null>(null)
  const [clashDetail, setClashDetail] = useState<ClashingClass | null>(null)
  const [wantDirect, setWantDirect] = useState(false)
  // Free rooms when the selected room is busy
  const [freeRooms, setFreeRooms] = useState<FreeClassroom[]>([])
  const [roomClash, setRoomClash] = useState(false)
  // Form centre picker — narrows batch list in the form
  const [formCentre, setFormCentre] = useState('')
  // Filters for the test list
  const [filterCentre, setFilterCentre] = useState('')
  const [filterBatchId, setFilterBatchId] = useState('')
  const [testSearch, setTestSearch] = useState('')
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

        // Load multi-batch mappings for all tests
        const { data: tbm } = await supabase.from('test_batch_mappings').select('test_id, batch_id').in('test_id', ids)
        const batchMappings: Record<string, string[]> = {}
        for (const mapping of (tbm ?? [])) {
          if (!batchMappings[mapping.test_id]) batchMappings[mapping.test_id] = []
          batchMappings[mapping.test_id].push(mapping.batch_id)
        }
        setTestBatchMappings(batchMappings)
      } else { 
        setTestChapters([])
        setChaptersByTest({})
        setTestBatchMappings({})
      }
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
  const visibleTests = useMemo(() => {
    return tests.filter((t) => {
      // Check if test is visible based on primary batch or any mapped batch
      if (visibleBatchIds.has(t.batch_id)) return true
      const mappedBatches = testBatchMappings[t.id] || []
      return mappedBatches.some(batchId => visibleBatchIds.has(batchId))
    })
  }, [tests, visibleBatchIds, testBatchMappings])

  // ---- Form derived --------------------------------------------------------
  const formBatch = batches.find((b) => b.id === batchId) ?? null
  const selectedBatchesList = Array.from(selectedBatches).map(id => batches.find(b => b.id === id)).filter(Boolean) as Batch[]
  const primaryBatch = selectedBatchesList.length > 0 ? selectedBatchesList[0] : formBatch // Use first selected batch or fallback to batchId for backward compatibility
  const centreFacultyIds = useMemo(() => {
    if (!primaryBatch) return new Set<string>()
    return new Set(userCentres.filter((uc) => uc.centre_id === primaryBatch.centre_id).map((uc) => uc.user_id))
  }, [userCentres, primaryBatch])
  const formFaculty = useMemo(
    () => (primaryBatch ? faculty.filter((f) => centreFacultyIds.has(f.id) || f.centre_id === primaryBatch.centre_id) : []),
    [faculty, primaryBatch, centreFacultyIds]
  )
  const formRooms = useMemo(
    () => (primaryBatch ? classrooms.filter((c) => c.centre_id === primaryBatch.centre_id && c.is_active) : []),
    [classrooms, primaryBatch]
  )
  const formSubjects = useMemo(
    () => (primaryBatch ? subjects.filter((s) => s.program_id === primaryBatch.program_id) : []),
    [subjects, primaryBatch]
  )

  // Load the subject's chapters (with a % taught hint). All are selectable —
  // central schedules a year ahead; the ≥60% check happens later via alerts.
  useEffect(() => {
    if (partType !== 'Part' || (!batchId && selectedBatches.size === 0) || !subjectId) { setEligible([]); return }
    let cancelled = false
    setLoadingChapters(true)
    const byDate = testDate || new Date().toISOString().split('T')[0]
    const activeBatchId = batchId || Array.from(selectedBatches)[0] // Use primary batch for chapter loading
    if (!activeBatchId) { setEligible([]); setLoadingChapters(false); return }
    getEligibleChapters(supabase, { batchId: activeBatchId, subjectId, byDate }).then((rows) => {
      if (!cancelled) { setEligible(rows); setLoadingChapters(false) }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partType, batchId, selectedBatches, subjectId, testDate])

  useEffect(() => {
    if (!primaryBatch || !testDate || !startTime || formFaculty.length === 0) { setFreeFacultyIds(null); return }
    let cancelled = false
    const dur = parseInt(duration, 10) || 60
    getFreeFacultyIds(supabase, {
      candidateFacultyIds: formFaculty.map((f) => f.id),
      date: testDate, startTime, durationMinutes: dur,
      ignoreTestId: editingId ?? undefined,
    }).then((set) => { if (!cancelled) setFreeFacultyIds(set) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryBatch, testDate, startTime, duration, formFaculty, editingId])

  useEffect(() => {
    if ((!batchId && selectedBatches.size === 0) || !testDate) { setFreeWindows([]); return }
    let cancelled = false
    const dur = parseInt(duration, 10) || 60
    const activeBatchId = batchId || Array.from(selectedBatches)[0] // Use primary batch for free windows
    if (!activeBatchId) { setFreeWindows([]); return }
    getBatchFreeWindows(supabase, { batchId: activeBatchId, date: testDate, durationMinutes: dur, ignoreTestId: editingId ?? undefined }).then((fw) => { if (!cancelled) setFreeWindows(fw) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, selectedBatches, testDate, duration, editingId])
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
  
  // Get batch names for a test (multi-batch support)
  const getTestBatchNames = (testId: string, primaryBatchId: string) => {
    const mappedBatchIds = testBatchMappings[testId] || []
    if (mappedBatchIds.length > 0) {
      // Multi-batch test: show all mapped batches
      const batchNames = mappedBatchIds
        .map(id => batches.find(b => b.id === id)?.name)
        .filter(Boolean)
        .join(', ')
      return `${batchNames} (${mappedBatchIds.length} batches)`
    } else {
      // Legacy single batch: show primary batch
      const batch = batches.find(b => b.id === primaryBatchId)
      return batch?.name || 'Unknown Batch'
    }
  }
  
  const resetForm = () => {
    setShowForm(false); setEditingId(null); setFormCentre('')
    setBatchId(''); setSelectedBatches(new Set()); setName(''); setTestDate(''); setStartTime('10:00'); setDuration('60')
    setTestType('Objective'); setPartType('Full'); setSubjectId(''); setFacultyId(''); setClassroomId('')
    setEligible([]); setSelectedChapters(new Set()); setCanShift(false); setFreeWindows([])
    setClashDetail(null); setFreeFacultyIds(null); setWantDirect(false); setFreeRooms([]); setRoomClash(false)
  }
  const startEdit = (t: TestRow) => {
    setEditingId(t.id); setShowForm(true); setMsg(null)
    setBatchId(t.batch_id); setName(t.name); setTestDate(t.test_date); setStartTime(t.start_time.slice(0, 5))
    setDuration(String(t.duration_minutes)); setTestType(t.test_type); setPartType(t.part_type)
    setSubjectId(t.subject_id ?? ''); setFacultyId(t.faculty_id ?? ''); setClassroomId(t.classroom_id ?? '')
    setSelectedChapters(new Set(testChapters.filter((tc) => tc.test_id === t.id).map(() => '').filter(Boolean))) // reset; reload below
    
    // Load selected batches for this test
    supabase.rpc('get_test_batches', { test_uuid: t.id }).then(({ data }) => {
      if (data && data.length > 0) {
        setSelectedBatches(new Set(data.map((b: any) => b.batch_id)))
        setBatchId('') // Clear single batch when multi-batch is used
      } else {
        setSelectedBatches(new Set(t.batch_id ? [t.batch_id] : [])) // Fallback to legacy single batch
      }
    })
    
    supabase.from('test_chapters').select('chapter_id').eq('test_id', t.id).then(({ data }) => {
      setSelectedChapters(new Set((data ?? []).map((r) => r.chapter_id as string)))
    })
  }

  const toggleBatch = (batchId: string) => {
    setSelectedBatches(prev => {
      const newSet = new Set(prev)
      if (newSet.has(batchId)) {
        newSet.delete(batchId)
      } else {
        newSet.add(batchId)
      }
      // Clear single batch selection when using multi-batch
      if (newSet.size > 0) {
        setBatchId('')
      }
      return newSet
    })
    // Reset dependent form fields when batch selection changes
    setFacultyId('')
    setClassroomId('')
    setSubjectId('')
    setSelectedChapters(new Set())
  }

  const toggleChapter = (id: string) => {
    setSelectedChapters((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const submit = (e: React.FormEvent) => { e.preventDefault(); doSubmit(false) }

  const doSubmit = async (testPriority: boolean, scheduleDirect = false) => {
    setMsg(null); setCanShift(false); setFreeRooms([]); setRoomClash(false)
    // Validate batch selection - either single batch or multiple batches
    const activeBatchIds = selectedBatches.size > 0 ? Array.from(selectedBatches) : (batchId ? [batchId] : [])
    if (activeBatchIds.length === 0) return setMsg({ type: 'error', text: 'Select at least one batch.' })
    if (!name.trim()) return setMsg({ type: 'error', text: 'Give the test a name.' })
    if (!testDate) return setMsg({ type: 'error', text: 'Pick a test date.' })
    const dur = parseInt(duration, 10)
    if (!dur || dur < 15 || dur > 480) return setMsg({ type: 'error', text: 'Duration must be 15–480 minutes.' })
    if (!classroomId) return setMsg({ type: 'error', text: 'Pick a room.' })
    // For multi-batch tests, ensure all batches are from the same centre and program
    const selectedBatchData = activeBatchIds.map(id => batches.find(b => b.id === id)).filter(Boolean) as Batch[]
    if (selectedBatchData.length > 1) {
      const centreIds = new Set(selectedBatchData.map(b => b.centre_id))
      const programIds = new Set(selectedBatchData.map(b => b.program_id))
      
      if (centreIds.size > 1) {
        return setMsg({ type: 'error', text: 'All selected batches must be from the same centre.' })
      }
      if (programIds.size > 1) {
        return setMsg({ type: 'error', text: 'All selected batches must be from the same program.' })
      }
    }
    
    let chapterIds: string[] = []
    if (partType === 'Part') {
      if (!subjectId) return setMsg({ type: 'error', text: 'Pick a subject for the part test.' })
      chapterIds = [...selectedChapters]
      if (chapterIds.length === 0) return setMsg({ type: 'error', text: 'Select at least one chapter for the part test.' })
    }

    setSaving(true)
    try {
      // Use primary batch (first selected) for the main test record
      const primaryBatchId = activeBatchIds[0]
      
      const input: TestInput = {
        batch_id: primaryBatchId,
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
      if (!res.ok) {
        const errMsg = res.error ?? 'Could not save the test.'
        setMsg({ type: 'error', text: errMsg })
        const isClassClash = !testPriority && /class|planned lecture/i.test(errMsg)
        const isRoomClash = !testPriority && /room/i.test(errMsg)
        
        setCanShift(isClassClash)
        setRoomClash(isRoomClash)
        
        if (isClassClash) {
          const cc = await getClashingClass(supabase, { batchId: primaryBatchId, date: testDate, startTime, durationMinutes: dur })
          setClashDetail(cc)
        } else {
          setClashDetail(null)
        }
        
        // Get free windows on same date
        const fw = await getBatchFreeWindows(supabase, { batchId: primaryBatchId, date: testDate, durationMinutes: dur, ignoreTestId: editingId ?? undefined })
        setFreeWindows(fw)
        
        // Get free rooms if room is the issue
        if (isRoomClash && primaryBatch) {
          const freeRms = await getFreeClassrooms(supabase, {
            centreId: primaryBatch.centre_id,
            date: testDate,
            startTime,
            durationMinutes: dur,
            excludeRoomId: classroomId,
            ignoreTestId: editingId ?? undefined,
          })
          setFreeRooms(freeRms)
        }
        
        return
      }
      
      // If we have multiple batches, map them to the test
      if (activeBatchIds.length > 1) {
        const testId = editingId || (res as any).id
        if (testId) {
          const { error: mapError } = await supabase.rpc('map_test_to_batches', {
            test_uuid: testId,
            batch_uuids: activeBatchIds
          })
          if (mapError) {
            console.warn('Failed to map test to multiple batches:', mapError)
          }
        }
      }
      
      const shiftNote = res.shifted ? ` ${res.shifted} lecture(s) shifted forward (buffer utilized).` : ''
      const unshiftNote = res.unshiftable ? ` ⚠ ${res.unshiftable} lecture(s) couldn't shift — no buffer left before batch end. Check Edit Planner.` : ''
      const batchNote = activeBatchIds.length > 1 ? ` Mapped to ${activeBatchIds.length} batches.` : ''
      // Always confirm immediately — no send/confirm flow
      const testId = editingId ?? (res as { id?: string }).id
      if (testId && !editingId) await setTestStage(supabase, testId, 'Confirmed')
      setMsg({ type: unshiftNote ? 'info' : 'success', text: (editingId ? 'Test updated.' : 'Test scheduled ✅') + shiftNote + unshiftNote + batchNote })
      resetForm()
      await loadData()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? `Something went wrong: ${err.message}` : 'Something went wrong saving the test — please try again.' })
    } finally {
      setSaving(false)
    }
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
    const revert = await revertTestShift(supabase, t.id)
    const { error } = await supabase.from('test_schedules').delete().eq('id', t.id)
    setBusyId(null)
    if (error) return setMsg({ type: 'error', text: error.message })
    let note = ''
    if (revert.reverted) note += ` ${revert.reverted} lecture(s) moved back to their original date.`
    if (revert.skipped) note += ` ${revert.skipped} lecture(s) couldn't auto-revert (their original slot is now used) — check Edit Planner.`
    setMsg({ type: 'success', text: `Test deleted.${note}` })
    await loadData()
  }
  // ---- Bulk CSV upload -----------------------------------------------------
  const downloadBulkTemplate = () => {
    const headers = ['Centre', 'Batch', 'Multiple Batches (same centre)', 'Subject', 'Test Name', 'Date', 'Time', 'Duration', 'Type', 'Scope', 'Chapters (GTT names; semicolon-separated)', 'Room', 'Invigilator Email']
    const example = ['Patna Superclass', 'CAF Jan 2027 B1', '(or: B1;B2;B3 — same centre)', '(blank=Full)', 'Mock Test 5', '2026-09-10', '10:00', '120', 'Objective', 'Full', 'Sets Relations Functions; Limits', '(optional room no)', '(optional)']
    const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)
    const csv = [headers.join(','), example.map(esc).join(',')].join('\n')
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }))
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
  const pickFreeRoom = async (rooms: Classroom[], centreId: string, date: string, time: string, dur: number): Promise<string | null> => {
    if (!rooms.length) return null
    // Use getFreeClassrooms which checks everything (weekly, planner, tests)
    const freeRooms = await getFreeClassrooms(supabase, { centreId, date, startTime: time, durationMinutes: dur })
    // Return first free room from our candidate list
    for (const room of rooms) {
      if (freeRooms.some(fr => fr.id === room.id)) return room.id
    }
    // Fallback: return first room from candidate list (best effort)
    return rooms[0]?.id ?? null
  }

  const parseBulk = async (text: string) => {
    setBulkMsg(null); setBulkRows([])
    const raw = parseCsvRows(text)
    if (raw.length < 2) { setBulkMsg({ type: 'error', text: 'The CSV needs a header row and at least one test row.' }); return }
    const headers = raw[0]
    const ci = {
      centre: colIndex(headers, ['centre', 'center']),
      batch: colIndex(headers, ['batch']),
      multiBatch: colIndex(headers, ['multiple batches', 'multiple batches (same centre)', 'multi batch', 'batches']),
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
    const rows: BulkRow[] = []
    for (let i = 1; i < raw.length; i++) {
      const cells = raw[i]
      if (cells[0]?.trim().startsWith('#')) continue // skip comment rows
      const centreName   = ci.centre >= 0 ? cells[ci.centre]?.trim() ?? '' : ''
      const batchName    = ci.batch >= 0  ? cells[ci.batch]?.trim() ?? '' : ''
      const multiBatchNames = ci.multiBatch >= 0 ? cells[ci.multiBatch]?.trim() ?? '' : ''
      const subjectName  = cells[ci.subject]?.trim() ?? ''
      const name         = cells[ci.name]?.trim() ?? ''
      const date         = normalizeDate(cells[ci.date]?.trim() ?? '')
      const time         = normalizeTime(cells[ci.time]?.trim() ?? '') ?? '10:00'
      const duration     = parseInt(cells[ci.duration]?.trim() ?? '60', 10)
      const type         = cells[ci.type]?.trim() || 'Objective'
      const scope        = cells[ci.scope]?.trim() === 'Part' ? 'Part' : 'Full'
      const chapterNames = cells[ci.chapters]?.trim() ?? ''
      const roomHint = cells[ci.room]?.trim() ?? ''
      const invigEmail = cells[ci.invig]?.trim() ?? ''

      const errors: string[] = []
      
      // Resolve centre to narrow batch search
      let resolvedCentreId: string | null = null
      if (centreName) {
        const foundCentre = centres.find(c => norm(c.name) === norm(centreName))
        if (!foundCentre) errors.push(`Centre "${centreName}" not found`)
        else resolvedCentreId = foundCentre.id
      }

      // Batch pool: filter by centre if provided
      const batchPool = resolvedCentreId
        ? visibleBatches.filter(b => b.centre_id === resolvedCentreId)
        : visibleBatches

      // Handle batch selection - either single batch or multiple batches
      let batchId: string | null = null
      let batchIds: string[] = []
      let batchLabel = ''
      
      if (multiBatchNames) {
        const batchNameList = multiBatchNames.split(';').map(n => n.trim()).filter(Boolean)
        const foundBatches = batchNameList.map(n => batchPool.find(b => norm(b.name) === norm(n)))
        const validBatches = foundBatches.filter(Boolean) as Batch[]
        if (validBatches.length === 0) {
          errors.push(`None of the batches found: ${batchNameList.join(', ')}${resolvedCentreId ? ` in ${centreName}` : ''}`)
        } else {
          const centreIds = new Set(validBatches.map(b => b.centre_id))
          const programIds = new Set(validBatches.map(b => b.program_id))
          if (centreIds.size > 1) errors.push('All batches must be from the same centre')
          else if (programIds.size > 1) errors.push('All batches must be from the same program')
          else {
            batchIds = validBatches.map(b => b.id)
            batchId = validBatches[0].id
            batchLabel = `${validBatches.map(b => b.name).join(', ')} (${validBatches.length} batches)`
          }
        }
      } else if (batchName) {
        const batch = batchPool.find(b => norm(b.name) === norm(batchName))
        if (!batch) errors.push(`Batch "${batchName}" not found${resolvedCentreId ? ` in ${centreName}` : ''}`)
        else { batchId = batch.id; batchIds = [batch.id]; batchLabel = batch.name }
      } else {
        errors.push('Batch name required (Batch column or Multiple Batches column)')
      }

      let subjectId: string | null = null
      if (scope === 'Part') {
        if (!subjectName) errors.push('Subject required for Part tests')
        else {
          const subject = subjects.find(s => norm(s.name) === norm(subjectName))
          if (!subject) errors.push(`Subject "${subjectName}" not found`)
          else subjectId = subject.id
        }
      }

      if (!name) errors.push('Test name is required')
      if (!date) errors.push('Invalid date format')
      if (isNaN(duration) || duration < 15 || duration > 480) errors.push('Duration must be 15-480 minutes')

      let chapterIds: string[] = []
      if (scope === 'Part' && chapterNames && subjectId) {
        const chapterNameList = chapterNames.split(';').map(n => n.trim()).filter(Boolean)
        const subjectChapters = await chaptersOfSubject(subjectId)
        chapterIds = chapterNameList.map(cn => subjectChapters.find(ch => norm(ch.name) === norm(cn))?.id).filter(Boolean) as string[]
        const missing = chapterNameList.filter(cn => !subjectChapters.some(ch => norm(ch.name) === norm(cn)))
        if (missing.length > 0) errors.push(`Chapters not in GTT: ${missing.join(', ')}`)
      } else if (scope === 'Part' && !chapterNames) {
        errors.push('Chapters required for Part scope (use GTT chapter names)')
      }

      let facultyId: string | null = null
      if (invigEmail) {
        const fac = faculty.find(f => f.id === invigEmail)
        if (!fac) errors.push(`Faculty "${invigEmail}" not found`)
        else facultyId = fac.id
      }

      rows.push({
        line: i + 1, raw: cells, batchId, batchIds, batchLabel, subjectId, scope, name, date, time, duration, testType: type,
        chapterIds, facultyId, classroomId: null, roomAutoAssigned: false, errors,
        status: errors.length ? 'error' : 'free', clashNote: null, completion: null,
      })
    }

    // Now validate slots and assign rooms
    for (const row of rows) {
      if (row.status === 'error' || !row.date || !row.batchId) continue

      // Check for test-vs-test clash first
      const primaryBatch = batches.find(b => b.id === row.batchId)
      if (!primaryBatch) continue

      const clash = await validateTestSlot(supabase, {
        batchId: row.batchId, date: row.date, startTime: row.time!, durationMinutes: row.duration,
        facultyId: row.facultyId, classroomId: row.classroomId
      })
      if (clash) {
        row.status = 'error'
        row.errors.push(`Test clash: ${clash}`)
        continue
      }

      // Check for class/lecture clash
      const classClash = await getClashingClass(supabase, {
        batchId: row.batchId, date: row.date, startTime: row.time!, durationMinutes: row.duration
      })
      if (classClash) {
        row.status = 'shift'
        const endTime = formatTime(
          new Date(new Date(`2000-01-01T${classClash.start_time}:00`).getTime() + classClash.duration_minutes * 60000)
            .toTimeString().slice(0, 5)
        )
        row.clashNote = `Clashes with ${classClash.subject_name} (${formatTime(classClash.start_time)}–${endTime})`
      }

      // Auto-assign room — use classrooms state (not formRooms which is form-specific)
      const centreRooms = classrooms.filter(r => r.centre_id === primaryBatch.centre_id && r.is_active)
      const assignedRoomId = await pickFreeRoom(centreRooms, primaryBatch.centre_id, row.date, row.time!, row.duration)
      if (assignedRoomId) {
        row.classroomId = assignedRoomId
        row.roomAutoAssigned = true
      } else if (centreRooms.length > 0) {
        row.classroomId = centreRooms[0].id
        row.roomAutoAssigned = true
      }

      // Syllabus completion check for Part tests
      if (row.scope === 'Part' && row.subjectId && row.chapterIds.length > 0) {
        const comp = await getTestCompletion(supabase, {
          batchId: row.batchId,
          byDate: row.date,
          partType: 'Part',
          subjectId: row.subjectId,
          chapterIds: row.chapterIds,
          programId: primaryBatch.program_id,
        })
        row.completion = comp
      }
    }

    setBulkRows(rows)
    setBulkMsg({ type: 'success', text: `Parsed ${rows.length} test(s). Review below, then click "Import All".` })
  }

  const bulkImport = async () => {
    if (bulkRows.length === 0) return
    setBulkBusy(true); setBulkMsg(null)
    let created = 0, skipped = 0, errCount = 0
    for (const row of bulkRows) {
      if (row.status === 'error') { skipped++; continue }
      try {
        const input: TestInput = {
          batch_id: row.batchId!,
          subject_id: row.subjectId,
          classroom_id: row.classroomId,
          faculty_id: row.facultyId,
          name: row.name,
          test_date: row.date!,
          start_time: row.time!,
          duration_minutes: row.duration,
          test_type: row.testType,
          part_type: row.scope,
          created_by: appUser?.id ?? null,
        }
        const testPriority = row.status === 'shift'
        const res = await createTest(supabase, input, row.chapterIds, { testPriority })
        if (res.ok) {
          // Always confirm immediately — no faculty send/confirm flow
          const testId = (res as any).id
          if (testId) {
            await setTestStage(supabase, testId, 'Confirmed')
            if (row.batchIds.length > 1) {
              await supabase.rpc('map_test_to_batches', { test_uuid: testId, batch_uuids: row.batchIds })
            }
          }
          created++
        } else {
          errCount++
        }
      } catch (err) {
        errCount++
      }
    }
    setBulkBusy(false)
    setBulkMsg({ type: created > 0 ? 'success' : 'error', text: `Import complete: ${created} created, ${skipped} skipped (errors), ${errCount} failed.` })
    if (created > 0) {
      setBulkRows([])
      await loadData()
    }
  }
  // ---- Filtering / Search ---------------------------------------------------
  const filteredTests = useMemo(() => {
    const fc = filterCentre, fb = filterBatchId, ts = testSearch.toLowerCase().trim()
    return visibleTests.filter((t) => {
      if (fc && !batches.find((b) => b.id === t.batch_id && b.centre_id === fc)) return false
      if (fb && t.batch_id !== fb && !(testBatchMappings[t.id] || []).includes(fb)) return false
      if (ts && !t.name.toLowerCase().includes(ts)) return false
      return true
    })
  }, [visibleTests, filterCentre, filterBatchId, testSearch, batches, testBatchMappings])

  const filteredCentres = useMemo(() => centres.filter((c) => allowedCentreIds.has(c.id)), [centres, allowedCentreIds])
  const filteredBatches = useMemo(() => {
    if (!filterCentre) return visibleBatches
    return visibleBatches.filter((b) => b.centre_id === filterCentre)
  }, [visibleBatches, filterCentre])
  // Batches in the form, filtered by the form centre picker
  const formCentreBatches = useMemo(() => {
    if (!formCentre) return visibleBatches
    return visibleBatches.filter((b) => b.centre_id === formCentre)
  }, [visibleBatches, formCentre])

  return (
    <div className="p-4 max-w-full mx-auto">
      <PageHeader title="Test Scheduler" description="Schedule, manage and track academic tests across batches" />
      
      {msg && <Alert type={msg.type}>{msg.text}</Alert>}

      <div className="flex gap-4 mb-6">
        <BtnPrimary onClick={() => { resetForm(); setShowForm(true) }}>+ New Test</BtnPrimary>
        <BtnSecondary onClick={() => setShowBulk(true)}>📄 Bulk Upload</BtnSecondary>
      </div>

      {/* ---- Test Form -------------------------------------------------------- */}
      {showForm && (
        <Card className="mb-6">
          <h3 className="text-xl font-semibold mb-4">{editingId ? 'Edit Test' : 'New Test'}</h3>
          <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Centre picker — narrows the batch list */}
            <div className="lg:col-span-2">
              <label className="block text-sm font-medium mb-1">Centre</label>
              <select value={formCentre} onChange={(e) => { setFormCentre(e.target.value); setBatchId(''); setSelectedBatches(new Set()) }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                <option value="">All centres</option>
                {filteredCentres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Batch Selection */}
            <div className="lg:col-span-2">
              <label className="block text-sm font-medium mb-2">📚 Batch(es) *</label>

              {/* Multi-batch selection */}
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-sm font-medium text-gray-700">Select Batches</label>
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">Recommended</span>
                </div>
                <div className="max-h-32 overflow-y-auto border rounded-lg p-2 bg-gray-50">
                  {formCentreBatches.map((b) => (
                    <label key={b.id} className="flex items-center gap-2 cursor-pointer hover:bg-white p-2 rounded text-sm">
                      <input
                        type="checkbox"
                        checked={selectedBatches.has(b.id)}
                        onChange={() => toggleBatch(b.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">{b.name}</div>
                        <div className="text-xs text-gray-500 truncate">📍 {centres.find((c) => c.id === b.centre_id)?.name ?? ''}</div>
                      </div>
                      {selectedBatches.has(b.id) && <span className="text-green-600 text-sm">✓</span>}
                    </label>
                  ))}
                </div>
                {selectedBatches.size > 0 && (
                  <div className="mt-2 p-2 bg-green-50 rounded border border-green-200">
                    <p className="text-xs text-green-700 font-medium">
                      ✓ Selected ({selectedBatches.size}): {Array.from(selectedBatches).map(id => batches.find(b => b.id === id)?.name).slice(0, 3).join(', ')}{selectedBatches.size > 3 ? ` +${selectedBatches.size - 3} more` : ''}
                    </p>
                  </div>
                )}
              </div>

              {/* Single batch fallback */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-sm font-medium text-gray-600">Single Batch</label>
                  <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full">Legacy</span>
                </div>
                <select
                  value={batchId}
                  onChange={(e) => {
                    setBatchId(e.target.value)
                    if (e.target.value) {
                      setSelectedBatches(new Set())
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={selectedBatches.size > 0}
                >
                  <option value="">Select single batch...</option>
                  {formCentreBatches.map((b) => <option key={b.id} value={b.id}>{b.name} — {centres.find((c) => c.id === b.centre_id)?.name ?? ''}</option>)}
                </select>
              </div>
            </div>

            {/* Test Details */}
            <div>
              <label className="block text-sm font-medium mb-1">Test Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Weekly Test 5"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Test Date *</label>
              <input
                type="date"
                value={testDate}
                onChange={(e) => setTestDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Start Time</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Duration (minutes)</label>
              <input
                type="number"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                min="15"
                max="480"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Test Type</label>
              <select
                value={testType}
                onChange={(e) => setTestType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="Objective">Objective</option>
                <option value="Subjective">Subjective</option>
                <option value="Mixed">Mixed</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Scope</label>
              <select
                value={partType}
                onChange={(e) => setPartType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="Full">Full Syllabus</option>
                <option value="Part">Specific Chapters</option>
              </select>
            </div>

            {/* Subject Selection for Part Tests */}
            {partType === 'Part' && (
              <div>
                <label className="block text-sm font-medium mb-1">Subject *</label>
                <select
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                >
                  <option value="">Select subject...</option>
                  {formSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}

            {/* Chapter Selection */}
            {partType === 'Part' && eligible.length > 0 && (
              <div className="lg:col-span-2">
                <label className="block text-sm font-medium mb-2">Chapters *</label>
                {loadingChapters ? (
                  <div className="text-gray-500">Loading chapters...</div>
                ) : (
                  <div className="max-h-32 overflow-y-auto border rounded-lg p-3 bg-gray-50">
                    {eligible.map((ch) => (
                      <label key={ch.chapter_id} className="flex items-center gap-2 cursor-pointer hover:bg-white p-1 rounded">
                        <input
                          type="checkbox"
                          checked={selectedChapters.has(ch.chapter_id)}
                          onChange={() => toggleChapter(ch.chapter_id)}
                          className="rounded border-gray-300"
                        />
                        <span className="text-sm">{ch.name}</span>
                        {ch.pct != null && (
                          <span className={`text-xs px-2 py-1 rounded ${ch.pct >= 60 ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                            {ch.pct}% taught
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Faculty Selection */}
            <div>
              <label className="block text-sm font-medium mb-1">Invigilator</label>
              <select
                value={facultyId}
                onChange={(e) => setFacultyId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Auto-assign</option>
                {formFaculty.map((f) => (
                  <option key={f.id} value={f.id} disabled={!!(freeFacultyIds && !freeFacultyIds.has(f.id))}>
                    {f.full_name} {f.faculty_type ? `(${f.faculty_type})` : ''} {freeFacultyIds && !freeFacultyIds.has(f.id) ? ' - busy' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Classroom Selection */}
            <div>
              <label className="block text-sm font-medium mb-1">Classroom *</label>
              <select
                value={classroomId}
                onChange={(e) => setClassroomId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              >
                <option value="">Select classroom...</option>
                {formRooms.map((c) => <option key={c.id} value={c.id}>{roomLabel(c)}</option>)}
              </select>
            </div>

            {/* Form Actions */}
            <div className="lg:col-span-2 flex flex-wrap gap-2 pt-4 border-t">
              <BtnPrimary type="submit" disabled={saving} className="text-sm">
                {saving ? 'Scheduling…' : editingId ? 'Update Test' : '✅ Schedule Test'}
              </BtnPrimary>

              {canShift && (
                <BtnPrimary
                  type="button"
                  onClick={() => doSubmit(true)}
                  disabled={saving}
                  className="bg-orange-600 hover:bg-orange-700 text-sm"
                >
                  {saving ? 'Scheduling…' : 'Schedule & Shift Classes'}
                </BtnPrimary>
              )}

              <BtnSecondary type="button" onClick={resetForm} className="text-sm">
                Cancel
              </BtnSecondary>
            </div>

            {/* Conflict Information */}
            {clashDetail && (
              <div className="lg:col-span-2 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <h4 className="font-medium text-amber-800 mb-2">📚 Class Conflict Detected</h4>
                <p className="text-sm text-amber-700 mb-2">
                  {clashDetail.subject_name} is scheduled {formatTime(clashDetail.start_time)}–{formatTime(
                    new Date(new Date(`2000-01-01T${clashDetail.start_time}:00`).getTime() + clashDetail.duration_minutes * 60000)
                      .toTimeString().slice(0, 5)
                  )}
                </p>
                <div className="text-sm text-amber-600 space-y-1">
                  <p><strong>What happens when you "Schedule (Shift Classes)":</strong></p>
                  <ul className="list-disc list-inside ml-2 space-y-1">
                    <li>Conflicting class will move to the next available buffer slot</li>
                    <li>One buffer slot will be utilized from the batch's reserved capacity</li>
                    <li>All subsequent classes remain on their scheduled dates</li>
                    <li>Test gets confirmed and scheduled at your chosen time</li>
                  </ul>
                </div>
              </div>
            )}

            {freeWindows.length > 0 && (
              <div className="lg:col-span-2 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="font-medium text-blue-800 mb-2">Suggested Free Times</h4>
                <div className="flex flex-wrap gap-2">
                  {freeWindows.slice(0, 6).map((fw, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setStartTime(fw.start)}
                      className="px-3 py-1 bg-blue-100 text-blue-800 text-sm rounded hover:bg-blue-200"
                    >
                      {formatTime(fw.start)}–{formatTime(fw.end)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {freeRooms.length > 0 && roomClash && (
              <div className="lg:col-span-2 p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <h4 className="font-medium text-purple-800 mb-2">Alternative Rooms Available</h4>
                <div className="flex flex-wrap gap-2">
                  {freeRooms.slice(0, 4).map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => setClassroomId(room.id)}
                      className="px-3 py-1 bg-purple-100 text-purple-800 text-sm rounded hover:bg-purple-200"
                    >
                      {room.room_no ? `${room.room_no} · ${room.name}` : room.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </form>
        </Card>
      )}
      {/* ---- Bulk Upload Modal ------------------------------------------------ */}
      {showBulk && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-6xl max-h-[90vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-semibold">Bulk Test Upload</h3>
              <button onClick={() => setShowBulk(false)} className="text-gray-500 hover:text-gray-700 text-xl">×</button>
            </div>

            {bulkMsg && <Alert type={bulkMsg.type}>{bulkMsg.text}</Alert>}

            <div className="mb-4">
              <BtnSecondary onClick={downloadBulkTemplate} className="mb-3">
                📥 Download CSV Template
              </BtnSecondary>
              
              <div>
                <label className="block text-sm font-medium mb-2">Upload CSV File</label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept=".csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        const reader = new FileReader()
                        reader.onload = (ev) => {
                          const text = ev.target?.result as string
                          if (text) parseBulk(text)
                        }
                        reader.readAsText(file)
                      }
                    }}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {bulkRows.length > 0 && (
                    <div className="text-sm text-gray-600">
                      {bulkRows.length} test(s) parsed
                    </div>
                  )}
                </div>
                
                {/* CSV Content Preview */}
                {bulkRows.length > 0 && (
                  <div className="mt-3 p-3 bg-gray-50 border rounded-lg">
                    <h4 className="font-medium text-gray-800 mb-2">CSV Content Preview</h4>
                    <div className="text-sm text-gray-600 space-y-1">
                      <div>📄 <strong>Total Tests:</strong> {bulkRows.length}</div>
                      <div>✅ <strong>Ready to Import:</strong> {bulkRows.filter(r => r.status !== 'error').length}</div>
                      <div>❌ <strong>Errors:</strong> {bulkRows.filter(r => r.status === 'error').length}</div>
                      <div>⚠️ <strong>Will Shift Classes:</strong> {bulkRows.filter(r => r.status === 'shift').length}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {bulkRows.length > 0 && (
              <div>
                <div className="flex gap-3 mb-4">
                  <BtnPrimary onClick={bulkImport} disabled={bulkBusy || bulkRows.every(r => r.status === 'error')}>
                    {bulkBusy ? 'Importing...' : `Import ${bulkRows.filter(r => r.status !== 'error').length} Test(s)`}
                  </BtnPrimary>
                  <BtnSecondary onClick={() => setBulkRows([])}>Clear</BtnSecondary>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse border border-gray-300 text-sm">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 px-3 py-2 text-left">Line</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Batch(es)</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Test Name</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Date & Time</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Room</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Status</th>
                        <th className="border border-gray-300 px-3 py-2 text-left">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkRows.map((row, i) => (
                        <tr key={i} className={
                          row.status === 'error' ? 'bg-red-50 border-red-200' : 
                          row.status === 'shift' ? 'bg-yellow-50 border-yellow-200' : 
                          'bg-green-50 border-green-200'
                        }>
                          <td className="border border-gray-300 px-3 py-2 font-mono text-xs">{row.line}</td>
                          <td className="border border-gray-300 px-3 py-2">
                            <div className="font-medium">{row.batchLabel}</div>
                            {row.batchIds.length > 1 && (
                              <div className="text-xs text-blue-600 mt-1">Multi-batch: {row.batchIds.length} batches</div>
                            )}
                          </td>
                          <td className="border border-gray-300 px-3 py-2 font-medium">{row.name}</td>
                          <td className="border border-gray-300 px-3 py-2">
                            <div>{row.date}</div>
                            <div className="text-xs text-gray-600">{row.time} ({row.duration}m)</div>
                          </td>
                          <td className="border border-gray-300 px-3 py-2">
                            {row.classroomId ? (
                              <div>
                                {classrooms.find(c => c.id === row.classroomId)?.name || 'Unknown Room'}
                                {row.roomAutoAssigned && (
                                  <div className="text-xs text-blue-600">Auto-assigned</div>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-400">No room</span>
                            )}
                          </td>
                          <td className="border border-gray-300 px-3 py-2">
                            <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                              row.status === 'error' ? 'bg-red-100 text-red-800' :
                              row.status === 'shift' ? 'bg-yellow-100 text-yellow-800' :
                              'bg-green-100 text-green-800'
                            }`}>
                              {row.status === 'error' ? '❌ Error' : row.status === 'shift' ? '⚠️ Will Shift' : '✅ Ready'}
                            </span>
                          </td>
                          <td className="border border-gray-300 px-3 py-2">
                            {row.errors.length > 0 ? (
                              <div className="space-y-1">
                                {row.errors.map((error, idx) => (
                                  <div key={idx} className="text-red-600 text-xs">• {error}</div>
                                ))}
                              </div>
                            ) : row.clashNote ? (
                              <div className="text-yellow-600 text-xs">⚠️ {row.clashNote}</div>
                            ) : row.completion && row.completion.pct < 60 ? (
                              <div className="text-yellow-600 text-xs">⚠️ Only {row.completion.pct}% syllabus taught</div>
                            ) : (
                              <div className="text-green-600 text-xs">✅ Ready to schedule</div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  
                  {/* Bulk Import Summary */}
                  <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <h4 className="font-medium text-blue-800 mb-2">📋 Import Summary</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-gray-800">{bulkRows.length}</div>
                        <div className="text-gray-600">Total Tests</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-600">{bulkRows.filter(r => r.status !== 'error').length}</div>
                        <div className="text-gray-600">Ready to Import</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-yellow-600">{bulkRows.filter(r => r.status === 'shift').length}</div>
                        <div className="text-gray-600">Will Shift Classes</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-red-600">{bulkRows.filter(r => r.status === 'error').length}</div>
                        <div className="text-gray-600">Errors to Fix</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ---- Test List Filters ------------------------------------------------ */}
      <div className="flex gap-4 mb-6 flex-wrap">
        <div>
          <label className="block text-sm font-medium mb-1">Centre</label>
          <select
            value={filterCentre}
            onChange={(e) => { setFilterCentre(e.target.value); setFilterBatchId('') }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All centres</option>
            {filteredCentres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Batch</label>
          <select
            value={filterBatchId}
            onChange={(e) => setFilterBatchId(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All batches</option>
            {filteredBatches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b)}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Search</label>
          <input
            type="text"
            value={testSearch}
            onChange={(e) => setTestSearch(e.target.value)}
            placeholder="Search test names..."
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* ---- Test List — Excel Table ---------------------------------------- */}
      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading tests…</div>
      ) : filteredTests.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          {visibleTests.length === 0 ? 'No tests scheduled yet.' : 'No tests match your filters.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full text-left text-sm min-w-[900px]">
            <thead>
              <tr className="bg-neutral-50 border-b border-neutral-200 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Test Name</th>
                <th className="px-3 py-2">Batch(es)</th>
                <th className="px-3 py-2">Centre</th>
                <th className="px-3 py-2">Type · Scope</th>
                <th className="px-3 py-2">Subject / Chapters</th>
                <th className="px-3 py-2">Room</th>
                <th className="px-3 py-2">Invigilator</th>
                <th className="px-3 py-2">Syllabus</th>
                {isPrivileged && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredTests.map((t) => {
                const batch      = batches.find((b) => b.id === t.batch_id)
                const centre     = centres.find((c) => c.id === batch?.centre_id)
                const subject    = subjects.find((s) => s.id === t.subject_id)
                const classroom  = classrooms.find((c) => c.id === t.classroom_id)
                const invigilator = faculty.find((f) => f.id === t.faculty_id)
                const chapters   = testChapterNames(t.id)
                const completion = completions[t.id]
                const isUpcoming = t.test_date >= new Date().toISOString().split('T')[0]
                return (
                  <tr key={t.id} className={`hover:bg-neutral-50 ${!isUpcoming ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2 whitespace-nowrap font-medium">
                      {new Date(t.test_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-500">
                      {formatTime(t.start_time)} <span className="text-xs">({t.duration_minutes}m)</span>
                    </td>
                    <td className="px-3 py-2 font-semibold">{t.name}</td>
                    <td className="px-3 py-2 max-w-[160px]">
                      <span className="truncate block text-neutral-700" title={getTestBatchNames(t.id, t.batch_id)}>
                        {getTestBatchNames(t.id, t.batch_id)}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-500">{centre?.name ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-xs bg-neutral-100 px-2 py-0.5 rounded-full">{t.test_type}</span>
                      {' · '}
                      <span className="text-xs text-neutral-500">{t.part_type}</span>
                    </td>
                    <td className="px-3 py-2 max-w-[180px]">
                      {t.part_type === 'Full'
                        ? <span className="text-xs text-neutral-400">Full syllabus</span>
                        : <div>
                            <span className="text-xs font-medium">{subject?.name}</span>
                            {chapters.length > 0 && <p className="text-xs text-neutral-400 truncate" title={chapters.join(', ')}>{chapters.join(', ')}</p>}
                          </div>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-600">{classroom ? roomLabel(classroom) : '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-600">
                      {invigilator ? `${invigilator.full_name}${invigilator.faculty_type ? ` (${invigilator.faculty_type})` : ''}` : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {completion && isUpcoming && completion.hasData
                        ? <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${completion.pct >= 60 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                            {completion.pct}%{completion.pct < 60 ? ' ⚠' : ''}
                          </span>
                        : <span className="text-neutral-300 text-xs">—</span>}
                    </td>
                    {isPrivileged && (
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {busyId === t.id
                          ? <span className="text-xs text-neutral-400">…</span>
                          : <>
                              <button onClick={() => startEdit(t)} className="text-xs font-semibold text-violet-600 hover:text-violet-800 mr-3">Edit</button>
                              <button onClick={() => deleteTest(t)} className="text-xs font-semibold text-red-500 hover:text-red-700">Delete</button>
                            </>}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}