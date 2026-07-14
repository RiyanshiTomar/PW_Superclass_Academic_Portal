'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { createTest, updateTest, setTestStage, getEligibleChapters, type EligibleChapter, type TestInput } from '@/lib/tests'
import { stageBadgeClass, formatTime } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

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

  const isPrivileged = scope === 'central' || scope === 'admin'

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const au = user ? await getAppUser(supabase, user) : null
    setAppUser(au)
    const [bRes, cRes, sRes, clRes, fRes, ucRes, tRes] = await Promise.all([
      supabase.from('batches').select('id, name, centre_id, program_id, batch_manager_id').order('name'),
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
        const { data: tc } = await supabase.from('test_chapters').select('test_id, chapters(name)').in('test_id', ids)
        setTestChapters((tc ?? []) as unknown as TestChapterRow[])
      } else setTestChapters([])
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

  const batchLabel = (b: Batch) => `${b.name} — ${centres.find((c) => c.id === b.centre_id)?.name ?? ''}`
  const roomLabel = (c: Classroom) => (c.room_no ? `${c.room_no} · ${c.name}` : c.name)
  const testChapterNames = (testId: string) =>
    testChapters.filter((tc) => tc.test_id === testId).map((tc) => one(tc.chapters)?.name).filter(Boolean) as string[]

  const resetForm = () => {
    setShowForm(false); setEditingId(null)
    setBatchId(''); setName(''); setTestDate(''); setStartTime('10:00'); setDuration('60')
    setTestType('Objective'); setPartType('Full'); setSubjectId(''); setFacultyId(''); setClassroomId('')
    setEligible([]); setSelectedChapters(new Set())
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!batchId) return setMsg({ type: 'error', text: 'Pick a batch.' })
    if (!name.trim()) return setMsg({ type: 'error', text: 'Give the test a name.' })
    if (!testDate) return setMsg({ type: 'error', text: 'Pick a test date.' })
    const dur = parseInt(duration, 10)
    if (!dur || dur < 15 || dur > 480) return setMsg({ type: 'error', text: 'Duration must be 15–480 minutes.' })
    if (!facultyId) return setMsg({ type: 'error', text: 'Assign a faculty (invigilator).' })
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
      faculty_id: facultyId,
      name: name.trim(),
      test_date: testDate,
      start_time: startTime,
      duration_minutes: dur,
      test_type: testType,
      part_type: partType,
      created_by: appUser?.id ?? null,
    }
    const res = editingId ? await updateTest(supabase, editingId, input, chapterIds) : await createTest(supabase, input, chapterIds)
    setSaving(false)
    if (!res.ok) return setMsg({ type: 'error', text: res.error ?? 'Could not save the test.' })
    setMsg({ type: 'success', text: editingId ? 'Test updated (saved as draft).' : 'Test saved as draft. Use “Send to Faculty” to assign.' })
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
        action={isPrivileged && !showForm ? <BtnPrimary onClick={() => { resetForm(); setShowForm(true) }}>+ Schedule Test</BtnPrimary> : undefined}
      />

      {msg && <Alert type={msg.type === 'info' ? 'info' : msg.type}>{msg.text}</Alert>}

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
                <label className="block text-xs font-medium text-neutral-500 mb-1">Faculty (invigilator) *</label>
                <select value={facultyId} onChange={(e) => setFacultyId(e.target.value)} className={input} disabled={!formBatch}>
                  <option value="">{formBatch ? 'Select faculty' : 'Pick batch first'}</option>
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

            <div className="flex gap-3">
              <BtnPrimary type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save Changes' : 'Save as Draft'}</BtnPrimary>
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : visibleTests.length === 0 ? (
        <Card className="p-10 text-center text-neutral-400">No tests scheduled yet.</Card>
      ) : (
        <div className="space-y-3">
          {visibleTests.map((t) => {
            const chNames = testChapterNames(t.id)
            return (
              <Card key={t.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-neutral-950">{t.name || 'Test'}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(t.stage)}`}>{t.stage}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{t.test_type}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">{t.part_type === 'Full' ? 'Full syllabus' : 'Part'}</span>
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
