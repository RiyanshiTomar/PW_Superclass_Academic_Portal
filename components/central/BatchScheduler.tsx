'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { checkWeeklyScheduleOverlap, checkClassroomScheduleOverlap } from '@/lib/scheduling'
import { assignPlanner } from '@/lib/planners'
import { validateBatchDates, validateTimeRange } from '@/lib/validation'
import { DAYS, timesOverlap } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Program = { id: string; name: string }
type Centre = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string | null }
type Classroom = { id: string; name: string; room_no: string | null; centre_id: string; is_active: boolean }
type Faculty = { id: string; full_name: string; email: string; centre_id: string | null }
type UserCentre = { user_id: string; centre_id: string }
type FacultySubject = { faculty_id: string; subject_id: string }
type Manager = { id: string; full_name: string; role: string | null; roles?: string[]; centre_id: string | null }
type Planner = { id: string; name: string }
type Link = { id: string; batch_id: string; planner_id: string; faculty_id: string; stage: string; planners: { name: string } | { name: string }[] | null }

type Batch = {
  id: string
  name: string
  program_id: string
  centre_id: string
  start_date: string
  end_date: string
  batch_manager_id: string
  status: string
}

// Each day of a row carries its OWN timing (Mon can differ from Tue for the
// same subject). active=false means that day has no class.
type DaySlot = { active: boolean; start: string; end: string }
type ScheduleRow = {
  faculty_id: string
  subject_id: string
  classroom_id: string
  days: DaySlot[]   // length 7 (Sun..Sat)
}

const emptyDays = (): DaySlot[] => Array.from({ length: 7 }, () => ({ active: false, start: '09:00', end: '10:00' }))

type FlatSchedule = {
  day_of_week: number
  start_time: string
  end_time: string
  faculty_id: string
  subject_id: string | null
  classroom_id: string | null
}

function flattenRows(rows: ScheduleRow[]): FlatSchedule[] {
  const result: FlatSchedule[] = []
  for (const row of rows) {
    if (!row.faculty_id) continue
    row.days.forEach((d, dayIndex) => {
      if (d.active) {
        result.push({
          day_of_week: dayIndex,
          start_time: d.start,
          end_time: d.end,
          faculty_id: row.faculty_id,
          subject_id: row.subject_id || null,
          classroom_id: row.classroom_id || null,
        })
      }
    })
  }
  return result
}

function plannerName(v: Link['planners']): string {
  if (!v) return 'Planner'
  if (Array.isArray(v)) return v[0]?.name ?? 'Planner'
  return v.name ?? 'Planner'
}

export default function BatchScheduler() {
  const supabase = createClient()
  const [batches, setBatches] = useState<Batch[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [managers, setManagers] = useState<Manager[]>([])
  const [planners, setPlanners] = useState<Planner[]>([])
  const [links, setLinks] = useState<Link[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [name, setName] = useState('')
  const [programId, setProgramId] = useState('')
  const [centreId, setCentreId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [managerId, setManagerId] = useState('')
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([])
  const [userCentres, setUserCentres] = useState<UserCentre[]>([])
  const [facultySubjects, setFacultySubjects] = useState<FacultySubject[]>([])

  // Attach-planner modal
  const [attachBatch, setAttachBatch] = useState<Batch | null>(null)
  const [attachPlanner, setAttachPlanner] = useState('')
  const [attaching, setAttaching] = useState(false)

  const centreFaculty = useMemo(() => {
    if (!centreId) return []
    const ids = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))
    return faculty.filter((f) => ids.has(f.id) || f.centre_id === centreId)
  }, [faculty, centreId, userCentres])

  // Active rooms at the selected centre — a class must run in one of these.
  const centreClassrooms = useMemo(
    () => (centreId ? classrooms.filter((c) => c.centre_id === centreId && c.is_active) : []),
    [classrooms, centreId]
  )

  const roomName = (id: string) => classrooms.find((c) => c.id === id)?.name ?? 'Room'

  // subject_id -> set of faculty ids that teach it (from admin faculty→subjects mapping)
  const subjectFacultyIds = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const fs of facultySubjects) {
      if (!m.has(fs.subject_id)) m.set(fs.subject_id, new Set())
      m.get(fs.subject_id)!.add(fs.faculty_id)
    }
    return m
  }, [facultySubjects])

  // Faculty at this centre who actually teach the given subject.
  // Falls back to all centre faculty when the subject has no mapping yet (so the form is never a dead-end).
  const facultyForSubject = (subjectId: string) => {
    const allowed = subjectFacultyIds.get(subjectId)
    if (!allowed || allowed.size === 0) return centreFaculty
    return centreFaculty.filter((f) => allowed.has(f.id))
  }

  const centreManagers = useMemo(() => {
    if (!centreId) return []
    const ids = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))
    return managers.filter((m) => {
      const isBM = m.role === 'batch_manager' || (m.roles || []).includes('batch_manager')
      return isBM && (ids.has(m.id) || m.centre_id === centreId)
    })
  }, [managers, centreId, userCentres])

  const programSubjects = useMemo(
    () => subjects.filter((s) => s.program_id === programId),
    [subjects, programId]
  )

  const subjName = (id: string) => subjects.find((s) => s.id === id)?.name ?? 'Subject'

  // Rebuild rows from an existing schedule. A row = one (subject + faculty + room)
  // group, with each day carrying its own timing. Every program subject gets at
  // least an empty row so all subjects are shown.
  const buildRows = (pid: string, flat: FlatSchedule[] = []): ScheduleRow[] => {
    const groups = new Map<string, ScheduleRow>()
    for (const f of flat) {
      const key = `${f.subject_id ?? ''}|${f.faculty_id}|${f.classroom_id ?? ''}`
      if (!groups.has(key)) groups.set(key, { subject_id: f.subject_id ?? '', faculty_id: f.faculty_id, classroom_id: f.classroom_id || '', days: emptyDays() })
      const row = groups.get(key)!
      row.days[f.day_of_week] = { active: true, start: f.start_time.slice(0, 5), end: f.end_time.slice(0, 5) }
    }
    const rows = Array.from(groups.values())
    // Ensure a row exists for every subject of the program.
    for (const s of subjects.filter((x) => x.program_id === pid)) {
      if (!rows.some((r) => r.subject_id === s.id)) rows.push({ subject_id: s.id, faculty_id: '', classroom_id: '', days: emptyDays() })
    }
    return rows
  }

  const handleProgramChange = (pid: string) => {
    setProgramId(pid)
    setScheduleRows(buildRows(pid))
  }

  const loadData = async () => {
    setLoading(true)
    setMessage(null)
    const [batchesRes, progRes, centRes, subjRes, classRes, facRes, manRes, ucRes, planRes, linkRes, fsRes] = await Promise.all([
      supabase.from('batches').select('*').order('created_at', { ascending: false }),
      supabase.from('programs').select('*').order('name'),
      supabase.from('centres').select('id, name').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
      supabase.from('classrooms').select('id, name, room_no, centre_id, is_active').order('room_no'),
      supabase.rpc('list_active_faculty', { p_centre_id: null }),
      supabase.from('app_users').select('id, full_name, email, role, roles, centre_id').or('role.eq.batch_manager,roles.cs.{batch_manager}').eq('status', 'active').order('full_name'),
      supabase.from('user_centres').select('user_id, centre_id'),
      supabase.from('planners').select('id, name').order('created_at', { ascending: false }),
      supabase.from('batch_planner_links').select('id, batch_id, planner_id, faculty_id, stage, planners(name)'),
      supabase.from('faculty_subjects').select('faculty_id, subject_id'),
    ])

    if (batchesRes.error) setMessage({ type: 'error', text: batchesRes.error.message })
    if (batchesRes.data) setBatches(batchesRes.data)
    if (progRes.data) setPrograms(progRes.data)
    if (centRes.data) setCentres(centRes.data as Centre[])
    if (subjRes.data) setSubjects(subjRes.data as Subject[])
    if (classRes.data) setClassrooms(classRes.data as Classroom[])

    if (facRes.error) {
      const fb = await supabase.from('app_users').select('id, full_name, email, centre_id').or('role.eq.faculty,roles.cs.{faculty}').eq('status', 'active').order('full_name')
      if (fb.data) setFaculty(Array.from(new Map(fb.data.map((f) => [f.id, f])).values()) as Faculty[])
    } else if (facRes.data) {
      setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
    }

    if (manRes.data) setManagers(manRes.data as Manager[])
    if (ucRes.data) setUserCentres(ucRes.data as UserCentre[])
    if (planRes.data) setPlanners(planRes.data as Planner[])
    if (linkRes.data) setLinks(linkRes.data as unknown as Link[])
    if (fsRes.data) setFacultySubjects(fsRes.data as FacultySubject[])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleCentreChange = (newCentreId: string) => {
    setCentreId(newCentreId)
    setManagerId((prev) => {
      const ids = new Set(userCentres.filter((uc) => uc.centre_id === newCentreId).map((uc) => uc.user_id))
      const valid = managers.some((m) => {
        const isBM = m.role === 'batch_manager' || (m.roles || []).includes('batch_manager')
        return m.id === prev && isBM && (ids.has(m.id) || m.centre_id === newCentreId)
      })
      return valid ? prev : ''
    })
    setScheduleRows((rows) =>
      rows.map((row) => {
        // Rooms belong to a centre — clear on centre change so a stale room can't leak across centres.
        let next = { ...row, classroom_id: '' }
        if (!row.faculty_id) return next
        const ids = new Set(userCentres.filter((uc) => uc.centre_id === newCentreId).map((uc) => uc.user_id))
        const fac = faculty.find((f) => f.id === row.faculty_id)
        if (!ids.has(row.faculty_id) && fac?.centre_id !== newCentreId) next = { ...next, faculty_id: '' }
        return next
      })
    )
  }

  const handleEdit = async (b: Batch) => {
    setEditingBatch(b)
    setName(b.name)
    setProgramId(b.program_id)
    setCentreId(b.centre_id)
    setStartDate(b.start_date)
    setEndDate(b.end_date)
    setManagerId(b.batch_manager_id)
    const { data } = await supabase.from('batch_schedules').select('*').eq('batch_id', b.id)
    setScheduleRows(buildRows(b.program_id, (data || []) as FlatSchedule[]))
    setShowForm(true)
    setMessage(null)
  }

  const resetForm = () => {
    setEditingBatch(null)
    setName(''); setProgramId(''); setCentreId(''); setStartDate(''); setEndDate(''); setManagerId('')
    setScheduleRows([])
    setShowForm(false)
    setMessage(null)
  }

  const updateRow = (index: number, patch: Partial<ScheduleRow>) => {
    setScheduleRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const addRow = () => setScheduleRows((prev) => [
    ...prev,
    { subject_id: programSubjects[0]?.id ?? '', faculty_id: '', classroom_id: '', days: emptyDays() },
  ])

  const removeRow = (index: number) => setScheduleRows((prev) => prev.filter((_, i) => i !== index))

  const toggleDay = (rowIndex: number, dayIndex: number) => {
    if (!centreId) return
    setScheduleRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIndex) return r
        const days = r.days.map((d, di) => (di === dayIndex ? { ...d, active: !d.active } : d))
        return { ...r, days }
      })
    )
  }

  const updateDayTime = (rowIndex: number, dayIndex: number, patch: Partial<DaySlot>) => {
    setScheduleRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIndex) return r
        const days = r.days.map((d, di) => (di === dayIndex ? { ...d, ...patch } : d))
        return { ...r, days }
      })
    )
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)
    setSaving(true)

    const trimmedName = name.trim()
    if (!trimmedName) return fail('Batch name is required.')
    if (!programId) return fail('Select a program.')
    if (!centreId) return fail('Select a centre first.')
    const dateErr = validateBatchDates(startDate, endDate)
    if (dateErr) return fail(dateErr)

    if (programSubjects.length === 0) return fail('This program has no subjects. Add subjects in Admin → Programs first.')
    if (scheduleRows.length === 0) return fail('Select program & centre to load subjects.')

    const centreIds = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))

    if (centreClassrooms.length === 0) return fail('This centre has no rooms yet. Add classrooms in Admin → Centres first.')

    // Each row needs a subject + faculty + room + timing + at least one day.
    for (let idx = 0; idx < scheduleRows.length; idx++) {
      const row = scheduleRows[idx]
      if (!row.subject_id) return fail(`Pick a subject for row ${idx + 1}.`)
      const sName = subjName(row.subject_id)
      if (!row.faculty_id) return fail(`Assign a faculty for "${sName}" (row ${idx + 1}).`)
      if (!row.classroom_id) return fail(`Pick a classroom for "${sName}" (row ${idx + 1}). Every class needs a room.`)
      if (!centreClassrooms.some((c) => c.id === row.classroom_id)) return fail(`The room chosen for "${sName}" is not at this centre.`)
      const activeDays = row.days.map((d, di) => ({ ...d, di })).filter((d) => d.active)
      if (activeDays.length === 0) return fail(`Pick at least one day for "${sName}" (row ${idx + 1}).`)
      for (const d of activeDays) {
        const timeErr = validateTimeRange(d.start, d.end)
        if (timeErr) return fail(`${sName} · ${DAYS[d.di]} (row ${idx + 1}): ${timeErr}`)
      }
      const fac = faculty.find((f) => f.id === row.faculty_id)
      if (!centreIds.has(row.faculty_id) && fac?.centre_id !== centreId) return fail(`${fac?.full_name ?? 'Faculty'} does not teach at this centre.`)
    }

    // Every subject of the program must have at least one slot (extra slots allowed).
    const covered = new Set(scheduleRows.map((r) => r.subject_id))
    const missing = programSubjects.filter((s) => !covered.has(s.id))
    if (missing.length > 0) return fail(`No class yet for: ${missing.map((s) => s.name).join(', ')}. Every subject needs at least one slot.`)

    const flat = flattenRows(scheduleRows)

    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        const sameDay = flat[i].day_of_week === flat[j].day_of_week
        if (!sameDay) continue
        const clash = timesOverlap(flat[i].start_time, flat[i].end_time, flat[j].start_time, flat[j].end_time)
        if (!clash) continue
        if (flat[i].faculty_id === flat[j].faculty_id) {
          return fail(`Faculty double-booked in this batch on ${DAYS[flat[i].day_of_week]}.`)
        }
        if (flat[i].classroom_id && flat[i].classroom_id === flat[j].classroom_id) {
          return fail(`Room "${roomName(flat[i].classroom_id!)}" is used twice at the same time on ${DAYS[flat[i].day_of_week]}.`)
        }
      }
    }

    for (const sch of flat) {
      const overlap = await checkWeeklyScheduleOverlap(supabase, sch.faculty_id, sch.day_of_week, sch.start_time, sch.end_time, editingBatch?.id)
      if (overlap) {
        const facName = faculty.find((f) => f.id === sch.faculty_id)?.full_name ?? 'Faculty'
        return fail(`${facName} — ${overlap} on ${DAYS[sch.day_of_week]}.`)
      }
      if (sch.classroom_id) {
        const roomClash = await checkClassroomScheduleOverlap(supabase, sch.classroom_id, sch.day_of_week, sch.start_time, sch.end_time, editingBatch?.id)
        if (roomClash) return fail(`Room "${roomName(sch.classroom_id)}" — ${roomClash} on ${DAYS[sch.day_of_week]}.`)
      }
    }

    let batchId = editingBatch?.id
    if (editingBatch) {
      const { error } = await supabase.from('batches').update({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).eq('id', editingBatch.id)
      if (error) return fail(error.message)
    } else {
      const { data, error } = await supabase.from('batches').insert({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).select().single()
      if (error) return fail(error.message)
      batchId = data.id
    }

    if (batchId) {
      await supabase.from('batch_schedules').delete().eq('batch_id', batchId)
      if (flat.length > 0) {
        const rows = flat.map((s) => ({ batch_id: batchId, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, faculty_id: s.faculty_id, subject_id: s.subject_id, classroom_id: s.classroom_id }))
        const { error } = await supabase.from('batch_schedules').insert(rows)
        if (error) return fail(error.message)
      }
    }

    setMessage({ type: 'success', text: editingBatch ? 'Batch updated.' : 'Batch created.' })
    resetForm()
    await loadData()
    setSaving(false)

    function fail(text: string) {
      setMessage({ type: 'error', text })
      setSaving(false)
    }
  }

  async function handleDelete(batch: Batch) {
    if (!confirm(`Delete batch "${batch.name}"? This also deletes its schedule and any planner links.`)) return
    setMessage(null)
    await supabase.from('batch_schedules').delete().eq('batch_id', batch.id)
    const { error } = await supabase.from('batches').delete().eq('id', batch.id)
    if (error) setMessage({ type: 'error', text: error.message })
    else { setMessage({ type: 'success', text: 'Batch deleted.' }); await loadData() }
  }

  function openAttach(batch: Batch) {
    setAttachBatch(batch)
    setAttachPlanner('')
    setMessage(null)
  }

  async function handleAttach() {
    if (!attachBatch || !attachPlanner) {
      setMessage({ type: 'error', text: 'Pick a planner.' })
      return
    }
    setAttaching(true)
    const res = await assignPlanner(supabase, {
      plannerId: attachPlanner,
      batch: { id: attachBatch.id, centre_id: attachBatch.centre_id, start_date: attachBatch.start_date, end_date: attachBatch.end_date },
    })
    setAttaching(false)
    if (!res.ok) {
      setMessage({ type: 'error', text: res.errors.join(' · ') })
      return
    }
    setMessage({ type: 'success', text: `Planner attached — ${res.imported} lecture(s) added${res.errors.length ? `, ${res.errors.length} skipped` : ''}. Manage stage in Batch Planner → Assign.` })
    setAttachBatch(null)
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent'

  return (
    <div>
      <PageHeader
        title="Batch Scheduler"
        description="Create batches and their week-wise recurring faculty schedule. Pick a subject per row. Overlapping timings are blocked. Optionally merge a batch with an existing planner."
        action={!showForm ? <BtnPrimary onClick={() => setShowForm(true)}>+ Create Batch</BtnPrimary> : undefined}
      />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {showForm ? (
        <Card className="p-6 sm:p-8 mb-8">
          <form onSubmit={handleSave}>
            <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider mb-4">Batch Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Batch Name *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="CA Found-A" />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Program *</label>
                <select required value={programId} onChange={(e) => handleProgramChange(e.target.value)} className={inputClass}>
                  <option value="">Select program</option>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Centre *</label>
                <select required value={centreId} onChange={(e) => handleCentreChange(e.target.value)} className={inputClass}>
                  <option value="">Select centre</option>
                  {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Start Date *</label>
                <input required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">End Date *</label>
                <input required type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Batch Manager *</label>
                <select required value={managerId} onChange={(e) => setManagerId(e.target.value)} className={inputClass} disabled={!centreId}>
                  <option value="">{centreId ? 'Select manager' : 'Select centre first'}</option>
                  {centreManagers.map((m) => {
                    const role = m.role || m.roles?.[0] || 'staff'
                    return <option key={m.id} value={m.id}>{m.full_name} ({role.replace('_', ' ')})</option>
                  })}
                </select>
              </div>
            </div>

            {!programId ? (
              <Alert type="info">Select a program above — its subjects will load automatically, one row each.</Alert>
            ) : programSubjects.length === 0 ? (
              <Alert type="error">This program has no subjects yet. Add them in Admin → Programs first.</Alert>
            ) : !centreId ? (
              <Alert type="info">Select a centre to pick faculty for each subject.</Alert>
            ) : centreFaculty.length === 0 ? (
              <Alert type="error">No active faculty found for this centre. Add faculty in Admin first.</Alert>
            ) : (
              <>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider">Weekly Schedule</h3>
                </div>
                <p className="text-xs text-neutral-500 mb-4">
                  All <span className="font-semibold text-violet-600">{programSubjects.length} subjects</span> of this program must have at least one slot (faculty, room &amp; timing). Add extra rows for more classes of any subject — overlaps are always blocked. ({centreFaculty.length} faculty · {centreClassrooms.length} room{centreClassrooms.length === 1 ? '' : 's'} at {centres.find((c) => c.id === centreId)?.name})
                </p>

                <div className="overflow-x-auto border border-neutral-200 rounded-xl mb-8">
                  <table className="w-full text-sm min-w-[900px]">
                    <thead>
                      <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-3 font-semibold min-w-[150px]">Subject *</th>
                        <th className="text-left px-3 py-3 font-semibold min-w-[160px]">Faculty *</th>
                        <th className="text-left px-3 py-3 font-semibold min-w-[150px]">Classroom *</th>
                        <th className="text-left px-3 py-3 font-semibold min-w-[300px]">Days &amp; Timings *</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {scheduleRows.map((row, rowIndex) => {
                        const filled = row.subject_id && row.faculty_id && row.classroom_id && row.days.some((d) => d.active)
                        // Show all faculty of the centre (no subject-based filtering for now).
                        const subjectFaculty = centreFaculty
                        return (
                        <tr key={rowIndex} className={filled ? '' : 'bg-amber-50/40'}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full shrink-0 ${filled ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                              <select value={row.subject_id} onChange={(e) => updateRow(rowIndex, { subject_id: e.target.value, faculty_id: '' })} className={inputClass}>
                                <option value="">Select subject</option>
                                {programSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <select value={row.faculty_id} onChange={(e) => updateRow(rowIndex, { faculty_id: e.target.value })} className={inputClass} disabled={subjectFaculty.length === 0}>
                              <option value="">{subjectFaculty.length === 0 ? 'No faculty at this centre' : 'Select faculty'}</option>
                              {subjectFaculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <select value={row.classroom_id} onChange={(e) => updateRow(rowIndex, { classroom_id: e.target.value })} className={inputClass} disabled={centreClassrooms.length === 0}>
                              <option value="">{centreClassrooms.length === 0 ? 'No rooms at centre' : 'Select room'}</option>
                              {centreClassrooms.map((c) => <option key={c.id} value={c.id}>{c.room_no ? `${c.room_no} · ${c.name}` : c.name}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1 mb-1.5">
                              {DAYS.map((d, dayIndex) => (
                                <button key={dayIndex} type="button" onClick={() => toggleDay(rowIndex, dayIndex)} className={`w-9 h-8 rounded-lg border text-[11px] font-bold transition-colors ${row.days[dayIndex].active ? 'bg-violet-500 text-white border-violet-600' : 'bg-white text-neutral-400 border-neutral-200 hover:border-neutral-400'}`}>{d}</button>
                              ))}
                            </div>
                            <div className="space-y-1">
                              {row.days.some((d) => d.active) ? row.days.map((d, dayIndex) => d.active && (
                                <div key={dayIndex} className="flex items-center gap-2 text-xs">
                                  <span className="w-9 font-semibold text-neutral-500">{DAYS[dayIndex]}</span>
                                  <input type="time" value={d.start} onChange={(e) => updateDayTime(rowIndex, dayIndex, { start: e.target.value })} className="h-8 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                  <span className="text-neutral-400">–</span>
                                  <input type="time" value={d.end} onChange={(e) => updateDayTime(rowIndex, dayIndex, { end: e.target.value })} className="h-8 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                </div>
                              )) : <span className="text-[11px] text-neutral-400">Pick day(s) above, then set each day&apos;s time.</span>}
                            </div>
                          </td>
                          <td className="px-2 py-3 text-center align-top">
                            <button type="button" onClick={() => removeRow(rowIndex)} title="Remove this row" className="text-neutral-300 hover:text-red-600 text-xl leading-none">×</button>
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <button type="button" onClick={addRow} className="mb-8 inline-flex items-center gap-1 text-sm font-semibold text-violet-600 hover:text-violet-700">
                  + Add another class
                </button>
              </>
            )}

            <div className="flex gap-3">
              <BtnPrimary type="submit" disabled={saving || !centreId}>{saving ? 'Saving…' : editingBatch ? 'Save Changes' : 'Create Batch'}</BtnPrimary>
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
          </form>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            <div className="col-span-full py-16 text-center text-neutral-400">Loading batches…</div>
          ) : batches.length === 0 ? (
            <div className="col-span-full py-16 text-center border border-dashed border-neutral-200 rounded-2xl text-neutral-500">No batches yet.</div>
          ) : (
            batches.map((b) => {
              const bl = links.filter((l) => l.batch_id === b.id)
              return (
                <Card key={b.id} className="p-6 hover:shadow-md transition-shadow flex flex-col">
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="font-bold text-neutral-950">{b.name}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{b.status}</span>
                  </div>
                  <div className="space-y-1.5 text-sm text-neutral-600 mb-4">
                    <p>{programs.find((p) => p.id === b.program_id)?.name}</p>
                    <p>{centres.find((c) => c.id === b.centre_id)?.name}</p>
                    <p className="text-xs text-neutral-400">{new Date(b.start_date).toLocaleDateString()} – {new Date(b.end_date).toLocaleDateString()}</p>
                  </div>
                  <div className="mb-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Linked Planners</p>
                    {bl.length === 0 ? (
                      <p className="text-xs text-neutral-400">None yet</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {bl.map((l) => (
                          <span key={l.id} className="text-[11px] bg-violet-50 text-violet-700 border border-violet-100 rounded px-2 py-0.5">{plannerName(l.planners)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-auto">
                    <BtnSecondary className="flex-1" onClick={() => handleEdit(b)}>Edit</BtnSecondary>
                    <button onClick={() => openAttach(b)} className="flex-1 px-3 py-2 bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 rounded-lg text-sm font-medium">Attach Planner</button>
                    <button onClick={() => handleDelete(b)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-sm font-medium">Delete</button>
                  </div>
                </Card>
              )
            })
          )}
        </div>
      )}

      {attachBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl border border-neutral-200">
            <h3 className="text-xl font-bold text-neutral-950 mb-1">Attach Planner</h3>
            <p className="text-sm text-neutral-500 mb-6">Merge <span className="font-semibold">{attachBatch.name}</span> with a planner. Each lecture is materialised onto this batch under the faculty set in the planner (overlaps blocked).</p>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner</label>
                <select value={attachPlanner} onChange={(e) => setAttachPlanner(e.target.value)} className={inputClass}>
                  <option value="">Select planner</option>
                  {planners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={handleAttach} disabled={attaching}>{attaching ? 'Attaching…' : 'Attach'}</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setAttachBatch(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
