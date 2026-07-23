'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { checkWeeklyScheduleOverlap, checkClassroomScheduleOverlap } from '@/lib/scheduling'
import { assignPlanner } from '@/lib/planners'
import { computeBatchPacing, type BatchPacing } from '@/lib/pacing'
import { mergeBatch } from '@/lib/merge'
import { validateBatchDates, validateTimeRange } from '@/lib/validation'
import { DAYS, timesOverlap, daysBetween, toMinutes, addDaysToDate } from '@/lib/utils'
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
// Each ROW is one subject's schedule for its OWN date-range (blank = whole
// batch). A subject can have several rows with different ranges — e.g. Mon/Tue
// for 20 Jul–01 Aug, then Wed/Fri from 02 Aug — so its pattern changes over time.
type ScheduleRow = {
  faculty_id: string
  subject_id: string
  classroom_id: string
  from: string
  to: string
  days: DaySlot[]   // length 7 (Sun..Sat)
}

const emptyDays = (): DaySlot[] => Array.from({ length: 7 }, () => ({ active: false, start: '09:00', end: '10:00' }))
const emptyRow = (subjectId = ''): ScheduleRow => ({ subject_id: subjectId, faculty_id: '', classroom_id: '', from: '', to: '', days: emptyDays() })

type FlatSchedule = {
  day_of_week: number
  start_time: string
  end_time: string
  faculty_id: string | null
  subject_id: string | null
  classroom_id: string | null
  effective_from: string | null
  effective_to: string | null
}

// Flatten rows into one entry per (active day), stamping each row's date-range.
function flattenRows(rows: ScheduleRow[]): FlatSchedule[] {
  const result: FlatSchedule[] = []
  for (const row of rows) {
    if (!row.days.some((d) => d.active)) continue
    row.days.forEach((d, dayIndex) => {
      if (!d.active) return
      result.push({
        day_of_week: dayIndex,
        start_time: d.start,
        end_time: d.end,
        faculty_id: row.faculty_id || null,
        subject_id: row.subject_id || null,
        classroom_id: row.classroom_id || null,
        effective_from: row.from || null,
        effective_to: row.to || null,
      })
    })
  }
  return result
}

// How many times weekday `dow` falls between two ISO dates (inclusive).
function weekdayOccurrences(from: string, to: string, dow: number): number {
  if (!from || !to || from > to) return 0
  const d = new Date(from + 'T12:00:00')
  const e = new Date(to + 'T12:00:00')
  let n = 0
  while (d <= e) {
    if (d.getDay() === dow) n++
    d.setDate(d.getDate() + 1)
  }
  return n
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
  // batch_id -> its last planned lecture date (for lateness vs end_date)
  const [lastLectureByBatch, setLastLectureByBatch] = useState<Map<string, string>>(new Map())
  // batch_id -> live pacing (per-subject done/planned vs end date) for suggestions
  const [pacingByBatch, setPacingByBatch] = useState<Record<string, BatchPacing>>({})
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([])
  const [userCentres, setUserCentres] = useState<UserCentre[]>([])
  const [facultySubjects, setFacultySubjects] = useState<FacultySubject[]>([])

  // Attach-planner modal
  const [attachBatch, setAttachBatch] = useState<Batch | null>(null)
  const [attachPlanner, setAttachPlanner] = useState('')
  const [attaching, setAttaching] = useState(false)

  // Merge-batches modal
  const [mergeOpen, setMergeOpen] = useState(false)
  const [survivorId, setSurvivorId] = useState('')
  const [absorbedId, setAbsorbedId] = useState('')
  const [merging, setMerging] = useState(false)

  // Batch list search + centre filter (to find a batch quickly).
  const [gridSearch, setGridSearch] = useState('')
  const [gridCentre, setGridCentre] = useState('')
  const shownBatches = useMemo(() => {
    const q = gridSearch.toLowerCase().trim()
    return batches.filter((b) => (!gridCentre || b.centre_id === gridCentre) && (!q || b.name.toLowerCase().includes(q)))
  }, [batches, gridSearch, gridCentre])

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

  // Faculty at this centre who actually teach the given subject (from the
  // faculty→subject mapping). Falls back to all centre faculty when the subject
  // has no mapping OR none of its mapped teachers are at this centre — so the
  // form is never a dead-end.
  const facultyForSubject = (subjectId: string) => {
    const allowed = subjectFacultyIds.get(subjectId)
    if (!allowed || allowed.size === 0) return centreFaculty
    const filtered = centreFaculty.filter((f) => allowed.has(f.id))
    return filtered.length ? filtered : centreFaculty
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

  const fmtHours = (min: number) => (min / 60).toFixed(min % 60 === 0 ? 0 : 1)

  // Hours + lecture count for ONE row over its own date-range (blank = whole
  // batch): each active day's duration × how many times that weekday falls in
  // the range. Shown inline on the row.
  const rowStats = (row: ScheduleRow): { minutes: number; lectures: number } => {
    const rf = row.from || startDate
    const rt = row.to || endDate
    if (!rf || !rt) return { minutes: 0, lectures: 0 }
    let minutes = 0
    let lectures = 0
    row.days.forEach((d, di) => {
      if (!d.active) return
      const occ = weekdayOccurrences(rf, rt, di)
      lectures += occ
      minutes += occ * Math.max(0, toMinutes(d.end) - toMinutes(d.start))
    })
    return { minutes, lectures }
  }

  // planner ids linked to each batch (for the same-planner merge rule)
  const plannersByBatch = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of links) {
      if (!m.has(l.batch_id)) m.set(l.batch_id, new Set())
      m.get(l.batch_id)!.add(l.planner_id)
    }
    return m
  }, [links])

  // Batches you can merge INTO the chosen survivor: same centre, not already
  // merged, and sharing at least one planner with it.
  const mergeCandidates = useMemo(() => {
    const survivor = batches.find((b) => b.id === survivorId)
    if (!survivor) return []
    const sPl = plannersByBatch.get(survivorId) ?? new Set<string>()
    return batches.filter((b) =>
      b.id !== survivorId &&
      b.status !== 'Merged' &&
      b.centre_id === survivor.centre_id &&
      Array.from(plannersByBatch.get(b.id) ?? new Set<string>()).some((p) => sPl.has(p))
    )
  }, [batches, survivorId, plannersByBatch])

  // Rebuild rows from an existing schedule. A row = one (subject + faculty +
  // room + date-range) group, each day carrying its own timing. A fresh batch
  // gets one empty (whole-batch) row per subject.
  // Dates are mandatory, so new rows default to the batch's full range (the
  // user narrows them per subject). fbFrom/fbTo are the batch start/end passed
  // in (setState is async, so we can't rely on the startDate/endDate state here).
  const buildRows = (pid: string, flat: FlatSchedule[] = [], fbFrom = '', fbTo = ''): ScheduleRow[] => {
    const groups = new Map<string, ScheduleRow>()
    for (const f of flat) {
      const from = f.effective_from ?? fbFrom
      const to = f.effective_to ?? fbTo
      const key = `${f.subject_id ?? ''}|${f.faculty_id ?? ''}|${f.classroom_id ?? ''}|${from}|${to}`
      if (!groups.has(key)) groups.set(key, { subject_id: f.subject_id ?? '', faculty_id: f.faculty_id ?? '', classroom_id: f.classroom_id || '', from, to, days: emptyDays() })
      groups.get(key)!.days[f.day_of_week] = { active: true, start: f.start_time.slice(0, 5), end: f.end_time.slice(0, 5) }
    }
    const rows = Array.from(groups.values())
    // Ensure every program subject has at least one row (pre-filled to the batch range).
    for (const s of subjects.filter((x) => x.program_id === pid)) {
      if (!rows.some((r) => r.subject_id === s.id)) rows.push({ ...emptyRow(s.id), from: fbFrom, to: fbTo })
    }
    // Subject-first ordering so a subject's rows sit together.
    rows.sort((a, b) => subjName(a.subject_id).localeCompare(subjName(b.subject_id)) || (a.from || '').localeCompare(b.from || ''))
    return rows
  }

  const handleProgramChange = (pid: string) => {
    setProgramId(pid)
    setScheduleRows(buildRows(pid, [], startDate, endDate))
  }

  // Batch-date changes flow into any row still on the batch default so the
  // mandatory row dates stay populated (and never fall outside the batch).
  const handleStartDate = (v: string) => {
    setScheduleRows((rows) => rows.map((r) => (!r.from || r.from < v ? { ...r, from: v } : r)))
    setStartDate(v)
  }
  const handleEndDate = (v: string) => {
    setScheduleRows((rows) => rows.map((r) => (!r.to || r.to > v ? { ...r, to: v } : r)))
    setEndDate(v)
  }

  const loadData = async () => {
    setLoading(true)
    setMessage(null)
    const [batchesRes, progRes, centRes, subjRes, classRes, facRes, manRes, ucRes, planRes, linkRes, fsRes, bpRes] = await Promise.all([
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
      supabase.from('batch_planners').select('batch_id, planned_date, is_buffer'),
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
    if (bpRes.data) {
      // Last REAL (non-buffer) lecture per batch — for the lateness chip.
      const m = new Map<string, string>()
      for (const r of bpRes.data as { batch_id: string; planned_date: string; is_buffer: boolean }[]) {
        if (r.is_buffer) continue
        const cur = m.get(r.batch_id)
        if (!cur || r.planned_date > cur) m.set(r.batch_id, r.planned_date)
      }
      setLastLectureByBatch(m)
    }

    // Live pacing for batches that have a planner linked (so the scheduler can
    // suggest "add classes for the lagging subject" as the end date nears).
    const today = new Date().toISOString().split('T')[0]
    const linkedBatchIds = Array.from(new Set(((linkRes.data ?? []) as { batch_id: string }[]).map((l) => l.batch_id)))
    if (linkedBatchIds.length) {
      const paces = await Promise.all(linkedBatchIds.map((id) => computeBatchPacing(supabase, id, today).catch(() => null)))
      const pm: Record<string, BatchPacing> = {}
      linkedBatchIds.forEach((id, i) => { if (paces[i]) pm[id] = paces[i]! })
      setPacingByBatch(pm)
    } else {
      setPacingByBatch({})
    }
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
    setScheduleRows(buildRows(b.program_id, (data || []) as FlatSchedule[], b.start_date, b.end_date))
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

  // --- Row mutation helpers (each row is one subject × its own date-range) ---
  const updateRow = (index: number, patch: Partial<ScheduleRow>) =>
    setScheduleRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  // Add another date-range for a subject: a new row appended right after that
  // subject's last range, starting the day AFTER it (natural continuation, no
  // overlap) and running to the batch end.
  const addRangeForSubject = (subjectId: string) =>
    setScheduleRows((prev) => {
      let lastIdx = -1
      prev.forEach((r, i) => { if (r.subject_id === subjectId) lastIdx = i })
      const anchorTo = lastIdx >= 0 ? (prev[lastIdx].to || endDate) : endDate
      const newFrom = anchorTo && endDate && anchorTo < endDate ? addDaysToDate(anchorTo, 1) : (startDate || '')
      const newRow = { ...emptyRow(subjectId), from: newFrom, to: endDate }
      const next = [...prev]
      if (lastIdx >= 0) next.splice(lastIdx + 1, 0, newRow)
      else next.push(newRow)
      return next
    })

  const removeRow = (index: number) => setScheduleRows((prev) => prev.filter((_, i) => i !== index))

  const toggleDay = (rowIndex: number, dayIndex: number) => {
    if (!centreId) return
    setScheduleRows((prev) => prev.map((r, i) => (i !== rowIndex ? r : { ...r, days: r.days.map((d, di) => (di === dayIndex ? { ...d, active: !d.active } : d)) })))
  }

  const updateDayTime = (rowIndex: number, dayIndex: number, patch: Partial<DaySlot>) =>
    setScheduleRows((prev) => prev.map((r, i) => (i !== rowIndex ? r : { ...r, days: r.days.map((d, di) => (di === dayIndex ? { ...d, ...patch } : d)) })))

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

    // Each row = one subject for its own date-range. Validate it fully.
    for (let idx = 0; idx < scheduleRows.length; idx++) {
      const row = scheduleRows[idx]
      if (!row.subject_id) return fail(`Row ${idx + 1}: pick a subject.`)
      const sName = subjName(row.subject_id)
      const where = `"${sName}" (row ${idx + 1})`
      if (!row.faculty_id) return fail(`${where}: assign a faculty.`)
      if (!row.classroom_id) return fail(`${where}: pick a classroom. Every class needs a room.`)
      if (!centreClassrooms.some((c) => c.id === row.classroom_id)) return fail(`${where}: the chosen room is not at this centre.`)
      // Date range is MANDATORY, must sit within the batch, and be forward.
      if (!row.from) return fail(`${where}: set the "from" date. It can't be empty (batch starts ${startDate}).`)
      if (!row.to) return fail(`${where}: set the "to" date. It can't be empty (batch ends ${endDate}).`)
      if (row.from < startDate) return fail(`${where}: the "from" date (${row.from}) can't be before the batch start (${startDate}).`)
      if (row.from > endDate) return fail(`${where}: the "from" date (${row.from}) can't be after the batch end (${endDate}).`)
      if (row.to > endDate) return fail(`${where}: the "to" date (${row.to}) can't be after the batch end (${endDate}).`)
      if (row.to < startDate) return fail(`${where}: the "to" date (${row.to}) can't be before the batch start (${startDate}).`)
      if (row.from > row.to) return fail(`${where}: the "from" date (${row.from}) is after the "to" date (${row.to}). Please fix the range.`)
      const rf0 = row.from
      const rt0 = row.to
      const activeDays = row.days.map((d, di) => ({ ...d, di })).filter((d) => d.active)
      if (activeDays.length === 0) return fail(`${where}: pick at least one day.`)
      for (const d of activeDays) {
        const timeErr = validateTimeRange(d.start, d.end)
        if (timeErr) return fail(`${where} · ${DAYS[d.di]}: ${timeErr}`)
        if (weekdayOccurrences(rf0, rt0, d.di) === 0) return fail(`${where}: ${DAYS[d.di]} never occurs between ${rf0} and ${rt0}. Remove ${DAYS[d.di]} or widen this row's dates.`)
      }
      const fac = faculty.find((f) => f.id === row.faculty_id)
      if (!centreIds.has(row.faculty_id) && fac?.centre_id !== centreId) return fail(`${where}: ${fac?.full_name ?? 'that faculty'} does not teach at this centre.`)
    }

    // Every subject of the program must have at least one row.
    const covered = new Set(scheduleRows.map((r) => r.subject_id))
    const missing = programSubjects.filter((s) => !covered.has(s.id))
    if (missing.length > 0) return fail(`No class yet for: ${missing.map((s) => s.name).join(', ')}. Every subject needs at least one row.`)

    const flat = flattenRows(scheduleRows)

    // Two slots only clash if same weekday, overlapping time AND overlapping
    // active dates — so the same weekday+time in a different date-segment is OK.
    const rangeHit = (a: FlatSchedule, b: FlatSchedule) => {
      const af = a.effective_from || startDate, at = a.effective_to || endDate
      const bf = b.effective_from || startDate, bt = b.effective_to || endDate
      return af <= bt && bf <= at
    }
    const dateWindow = (a: FlatSchedule) => `${a.effective_from || startDate} to ${a.effective_to || endDate}`

    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        if (flat[i].day_of_week !== flat[j].day_of_week) continue
        if (!timesOverlap(flat[i].start_time, flat[i].end_time, flat[j].start_time, flat[j].end_time)) continue
        if (!rangeHit(flat[i], flat[j])) continue
        const day = DAYS[flat[i].day_of_week]
        // Two unassigned (null) slots aren't a "same faculty" clash — only flag
        // when the same real teacher is booked twice.
        if (flat[i].faculty_id && flat[i].faculty_id === flat[j].faculty_id) {
          const facName = faculty.find((f) => f.id === flat[i].faculty_id)?.full_name ?? 'This faculty'
          return fail(`${facName} is booked twice on ${day} (${flat[i].start_time}–${flat[i].end_time} and ${flat[j].start_time}–${flat[j].end_time}) during overlapping dates (${dateWindow(flat[i])}). Change the time, day, or active dates of one class.`)
        }
        if (flat[i].classroom_id && flat[i].classroom_id === flat[j].classroom_id) {
          return fail(`Room "${roomName(flat[i].classroom_id!)}" is used by two classes on ${day} at overlapping times (${flat[i].start_time}–${flat[i].end_time} and ${flat[j].start_time}–${flat[j].end_time}) during overlapping dates (${dateWindow(flat[i])}). Change the room, time, or active dates.`)
        }
      }
    }

    for (const sch of flat) {
      const rf = sch.effective_from || startDate
      const rt = sch.effective_to || endDate
      // A teacher can only clash if one is assigned; unassigned slots skip this.
      if (sch.faculty_id) {
        const overlap = await checkWeeklyScheduleOverlap(supabase, sch.faculty_id, sch.day_of_week, sch.start_time, sch.end_time, editingBatch?.id, rf, rt)
        if (overlap) {
          const facName = faculty.find((f) => f.id === sch.faculty_id)?.full_name ?? 'Faculty'
          return fail(`${facName} already has a ${overlap.replace('Recurring class in batch ', 'class in batch ')} on ${DAYS[sch.day_of_week]} at ${sch.start_time}–${sch.end_time} (within ${rf} to ${rt}). Pick a different time or teacher.`)
        }
      }
      if (sch.classroom_id) {
        const roomClash = await checkClassroomScheduleOverlap(supabase, sch.classroom_id, sch.day_of_week, sch.start_time, sch.end_time, editingBatch?.id, rf, rt)
        if (roomClash) return fail(`Room "${roomName(sch.classroom_id)}" is busy on ${DAYS[sch.day_of_week]} at ${sch.start_time}–${sch.end_time} (within ${rf} to ${rt}) — it ${roomClash.replace('Room already hosts', 'already hosts')}. Pick another room or time.`)
      }
    }

    let batchId = editingBatch?.id
    if (editingBatch) {
      // .select() so we can tell if the row actually existed — a stale UI entry
      // (batch deleted/merged elsewhere) would update 0 rows and then blow up on
      // the schedule insert with a foreign-key error.
      const { data, error } = await supabase.from('batches').update({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).eq('id', editingBatch.id).select('id')
      if (error) return fail(error.message)
      if (!data || data.length === 0) { await loadData(); return fail('This batch no longer exists (it may have been deleted or merged). The list has been refreshed — please create it again or pick another batch.') }
    } else {
      const { data, error } = await supabase.from('batches').insert({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).select('id').single()
      if (error) return fail(error.message)
      if (!data?.id) return fail('Could not create the batch (no id returned). Check your access/permissions and try again.')
      batchId = data.id
    }

    if (batchId) {
      await supabase.from('batch_schedules').delete().eq('batch_id', batchId)
      if (flat.length > 0) {
        const rows = flat.map((s) => ({ batch_id: batchId, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, faculty_id: s.faculty_id, subject_id: s.subject_id, classroom_id: s.classroom_id, effective_from: s.effective_from, effective_to: s.effective_to }))
        const { error } = await supabase.from('batch_schedules').insert(rows)
        if (error) {
          const msg = /foreign key|batch_id_fkey/i.test(error.message)
            ? 'The batch record went missing while saving the schedule (it may have been deleted elsewhere). The list will refresh — please try again.'
            : error.message
          await loadData()
          return fail(msg)
        }
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

  async function handleMerge() {
    if (!survivorId || !absorbedId) { setMessage({ type: 'error', text: 'Pick both batches.' }); return }
    const survivor = batches.find((b) => b.id === survivorId)
    const absorbed = batches.find((b) => b.id === absorbedId)
    if (!confirm(`Merge "${absorbed?.name}" INTO "${survivor?.name}"?\n\nAll students move to "${survivor?.name}". "${absorbed?.name}" is archived — its future classes/tests are removed, past records (attendance/results) are kept. This can't be auto-undone.`)) return
    setMerging(true); setMessage(null)
    const today = new Date().toISOString().split('T')[0]
    const res = await mergeBatch(supabase, { survivorId, absorbedId, today })
    setMerging(false)
    if (!res.ok) { setMessage({ type: 'error', text: res.error ?? 'Merge failed.' }); return }
    setMessage({ type: 'success', text: `Merged — ${res.movedStudents} student(s) moved to ${survivor?.name}. ${absorbed?.name} archived.` })
    setMergeOpen(false); setSurvivorId(''); setAbsorbedId('')
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent'

  return (
    <div>
      <PageHeader
        title="Batch Scheduler"
        description="Create batches and their recurring weekly schedule. Each row can run for the whole batch or a date-range segment (so the pattern can change over time). Live per-subject hours; overlaps always blocked. Optionally merge a batch with an existing planner."
        action={!showForm ? (
          <div className="flex gap-2">
            <BtnSecondary onClick={() => { setMergeOpen(true); setMessage(null); setSurvivorId(''); setAbsorbedId('') }}>Merge Batches</BtnSecondary>
            <BtnPrimary onClick={() => setShowForm(true)}>+ Create Batch</BtnPrimary>
          </div>
        ) : undefined}
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
                <input required type="date" value={startDate} onChange={(e) => handleStartDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">End Date *</label>
                <input required type="date" value={endDate} min={startDate || undefined} onChange={(e) => handleEndDate(e.target.value)} className={inputClass} />
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
                  One card per subject. Give each subject a date range with its days &amp; timings. To change a subject&apos;s days part-way through the batch, click <span className="font-semibold text-violet-600">+ another date range</span> in its card — e.g. Accounts <span className="font-medium">Mon/Tue 20 Jul→1 Aug</span>, then <span className="font-medium">Wed/Fri 2 Aug→20 Aug</span>. Each range shows its own hours, and the card header shows the subject&apos;s total. From &amp; To are required and must stay within the batch. Overlaps are always blocked. ({centreFaculty.length} faculty · {centreClassrooms.length} room{centreClassrooms.length === 1 ? '' : 's'} at {centres.find((c) => c.id === centreId)?.name})
                </p>

                <div className="space-y-4 mb-8">
                  {programSubjects.map((subj) => {
                    const items = scheduleRows.map((r, i) => ({ row: r, rowIndex: i })).filter((x) => x.row.subject_id === subj.id)
                    const subjMin = items.reduce((a, x) => a + rowStats(x.row).minutes, 0)
                    const subjLec = items.reduce((a, x) => a + rowStats(x.row).lectures, 0)
                    const multi = items.length > 1
                    const subjectFaculty = facultyForSubject(subj.id)
                    return (
                    <div key={subj.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-neutral-50 border-b border-neutral-200">
                        <h4 className="font-bold text-neutral-950">{subj.name}</h4>
                        <span className="text-xs font-semibold text-violet-700 whitespace-nowrap">Total {fmtHours(subjMin)} hrs · {subjLec} class{subjLec === 1 ? '' : 'es'}</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[900px]">
                          <thead>
                            <tr className="bg-white text-neutral-400 text-[11px] uppercase tracking-wider border-b border-neutral-100">
                              {multi && <th className="text-left pl-4 pr-1 py-2 font-semibold w-16">Range</th>}
                              <th className={`text-left ${multi ? 'px-2' : 'px-4'} py-2 font-semibold min-w-[160px]`}>Faculty *</th>
                              <th className="text-left px-2 py-2 font-semibold min-w-[150px]">Classroom *</th>
                              <th className="text-left px-2 py-2 font-semibold min-w-[180px]">Date range *</th>
                              <th className="text-left px-2 py-2 font-semibold min-w-[280px]">Days &amp; Timings *</th>
                              <th className="text-right px-2 py-2 font-semibold min-w-[90px]">Hours</th>
                              <th className="w-8" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100">
                            {items.map(({ row, rowIndex }, k) => {
                              const filled = row.faculty_id && row.classroom_id && row.days.some((d) => d.active)
                              const stats = rowStats(row)
                              return (
                              <tr key={rowIndex} className={filled ? '' : 'bg-amber-50/40'}>
                                {multi && (
                                  <td className="pl-4 pr-1 py-3 align-top">
                                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-neutral-500"><span className={`h-2 w-2 rounded-full ${filled ? 'bg-emerald-500' : 'bg-amber-400'}`} />{k + 1}</span>
                                  </td>
                                )}
                                <td className={`${multi ? 'px-2' : 'px-4'} py-3`}>
                                  <div className="flex items-center gap-2">
                                    {!multi && <span className={`h-2 w-2 rounded-full shrink-0 ${filled ? 'bg-emerald-500' : 'bg-amber-400'}`} />}
                                    <select value={row.faculty_id} onChange={(e) => updateRow(rowIndex, { faculty_id: e.target.value })} className={inputClass} disabled={subjectFaculty.length === 0}>
                                      <option value="">{subjectFaculty.length === 0 ? 'No faculty at this centre' : 'Select faculty'}</option>
                                      {subjectFaculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                                    </select>
                                  </div>
                                </td>
                                <td className="px-2 py-3">
                                  <select value={row.classroom_id} onChange={(e) => updateRow(rowIndex, { classroom_id: e.target.value })} className={inputClass} disabled={centreClassrooms.length === 0}>
                                    <option value="">{centreClassrooms.length === 0 ? 'No rooms at centre' : 'Select room'}</option>
                                    {centreClassrooms.map((c) => <option key={c.id} value={c.id}>{c.room_no ? `${c.room_no} · ${c.name}` : c.name}</option>)}
                                  </select>
                                </td>
                                <td className="px-2 py-3 align-top">
                                  <div className="space-y-1.5">
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-7 shrink-0 text-[10px] font-semibold uppercase text-neutral-400">From</span>
                                      <input type="date" required value={row.from} min={startDate || undefined} max={endDate || undefined} onChange={(e) => updateRow(rowIndex, { from: e.target.value })} className="h-8 w-full px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-7 shrink-0 text-[10px] font-semibold uppercase text-neutral-400">To</span>
                                      <input type="date" required value={row.to} min={row.from || startDate || undefined} max={endDate || undefined} onChange={(e) => updateRow(rowIndex, { to: e.target.value })} className="h-8 w-full px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                    </div>
                                  </div>
                                </td>
                                <td className="px-2 py-3">
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
                                    )) : <span className="text-[11px] text-neutral-400">Pick day(s), then set each day&apos;s time.</span>}
                                  </div>
                                </td>
                                <td className="px-2 py-3 text-right align-top">
                                  <div className="font-bold text-neutral-800 whitespace-nowrap">{fmtHours(stats.minutes)} hrs</div>
                                  <div className="text-[11px] text-neutral-400">{stats.lectures} class{stats.lectures === 1 ? '' : 'es'}</div>
                                </td>
                                <td className="px-2 py-3 text-center align-top">
                                  {multi && <button type="button" onClick={() => removeRow(rowIndex)} title="Remove this date range" className="text-neutral-300 hover:text-red-600 text-xl leading-none">×</button>}
                                </td>
                              </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="px-4 py-2 border-t border-neutral-100 bg-neutral-50/40">
                        <button type="button" onClick={() => addRangeForSubject(subj.id)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-violet-200 bg-violet-50 text-xs font-semibold text-violet-700 hover:bg-violet-100 active:scale-95 transition">+ another date range</button>
                      </div>
                    </div>
                    )
                  })}
                </div>
              </>
            )}

            <div className="flex gap-3">
              <BtnPrimary type="submit" disabled={saving || !centreId}>{saving ? 'Saving…' : editingBatch ? 'Save Changes' : 'Create Batch'}</BtnPrimary>
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
          </form>
        </Card>
      ) : (
        <div>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Search batch</label>
              <input value={gridSearch} onChange={(e) => setGridSearch(e.target.value)} placeholder="Type a batch name…" className="w-full h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
              <select value={gridCentre} onChange={(e) => setGridCentre(e.target.value)} className="h-11 min-w-[200px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                <option value="">All centres</option>
                {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {!loading && <span className="pb-2 text-sm text-neutral-400">{shownBatches.length} batch{shownBatches.length === 1 ? '' : 'es'}</span>}
          </div>
          {!loading && (() => {
            const attention = shownBatches.map((b) => ({ b, p: pacingByBatch[b.id] })).filter((x) => x.p && x.p.subjects.some((s) => s.status === 'behind'))
            if (attention.length === 0) return null
            return (
              <Alert type="error">
                <b>{attention.length} batch{attention.length === 1 ? '' : 'es'} need attention</b> — a subject will finish after the end date. {attention.slice(0, 4).map((x) => `${x.b.name} (${x.p!.subjects.filter((s) => s.status === 'behind').map((s) => s.name).join('/')})`).join(' · ')}{attention.length > 4 ? ' …' : ''}. Open the batch and add classes for the lagging subject(s).
              </Alert>
            )
          })()}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            <div className="col-span-full py-16 text-center text-neutral-400">Loading batches…</div>
          ) : batches.length === 0 ? (
            <div className="col-span-full py-16 text-center border border-dashed border-neutral-200 rounded-2xl text-neutral-500">No batches yet.</div>
          ) : shownBatches.length === 0 ? (
            <div className="col-span-full py-16 text-center border border-dashed border-neutral-200 rounded-2xl text-neutral-500">No batches match your search/centre.</div>
          ) : (
            shownBatches.map((b) => {
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
                    {(() => {
                      const last = lastLectureByBatch.get(b.id)
                      if (!last) return null
                      // last = last REAL (non-buffer) lecture. Past end date = buffer consumed → late.
                      const delay = daysBetween(b.end_date, last)
                      const cls = delay <= 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'
                      const label = delay <= 0 ? 'On track' : `Late by ${delay}d`
                      return <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cls}`} title={`Last real lecture ${new Date(last + 'T12:00:00').toLocaleDateString()} · planned end ${new Date(b.end_date).toLocaleDateString()}`}>{label}</span>
                    })()}
                  </div>
                  {pacingByBatch[b.id] && (() => {
                    const p = pacingByBatch[b.id]
                    const behind = p.subjects.filter((s) => s.status === 'behind')
                    const ahead = p.subjects.filter((s) => s.status === 'ahead')
                    return (
                      <div className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50/60 p-2.5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1.5">Pacing · {p.daysLeft}d left</p>
                        <div className="flex flex-wrap gap-1">
                          {p.subjects.map((s) => (
                            <span key={s.subjectId} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${s.status === 'behind' ? 'bg-red-50 text-red-700 border-red-200' : s.status === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s.status === 'done' ? 'bg-neutral-100 text-neutral-500 border-neutral-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`} title={`${s.doneLectures}/${s.totalLectures} done · finishes ${s.finishDate ?? '—'}${s.marginDays != null ? ` (${s.marginDays < 0 ? Math.abs(s.marginDays) + 'd over' : s.marginDays + 'd spare'})` : ''}`}>{s.name} {s.doneLectures}/{s.totalLectures}</span>
                          ))}
                        </div>
                        {behind.length > 0 ? (
                          <p className="mt-1.5 text-[11px] text-red-700">⚠ Add classes for {behind.map((s) => `${s.name} (${Math.abs(s.marginDays ?? 0)}d over)`).join(', ')}{ahead.length ? ` · slack in ${ahead.map((s) => s.name).join(', ')}` : ''}.</p>
                        ) : ahead.length > 0 ? (
                          <p className="mt-1.5 text-[11px] text-emerald-700">Ahead: {ahead.map((s) => s.name).join(', ')} — slack available; you can ease off or bring a lagging subject&apos;s topics sooner.</p>
                        ) : (
                          <p className="mt-1.5 text-[11px] text-neutral-400">On track for the end date.</p>
                        )}
                      </div>
                    )
                  })()}
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
                    <button onClick={() => openAttach(b)} disabled={bl.length > 0} title={bl.length > 0 ? 'A planner is already attached to this batch' : 'Attach a planner'} className={`flex-1 px-3 py-2 border rounded-lg text-sm font-medium ${bl.length > 0 ? 'bg-neutral-100 text-neutral-400 border-neutral-200 cursor-not-allowed' : 'bg-violet-50 hover:bg-violet-100 text-violet-700 border-violet-200'}`}>{bl.length > 0 ? 'Planner attached' : 'Attach Planner'}</button>
                    <button onClick={() => handleDelete(b)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-sm font-medium">Delete</button>
                  </div>
                </Card>
              )
            })
          )}
          </div>
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

      {mergeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl border border-neutral-200">
            <h3 className="text-xl font-bold text-neutral-950 mb-1">Merge Batches</h3>
            <p className="text-sm text-neutral-500 mb-6">Combine two batches that run the <span className="font-semibold">same planner</span> at the same centre. Students move into the batch you keep; the other is archived (its future classes &amp; tests are removed, past records stay).</p>
            <div className="space-y-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Keep this batch (survivor)</label>
                <select value={survivorId} onChange={(e) => { setSurvivorId(e.target.value); setAbsorbedId('') }} className={inputClass}>
                  <option value="">Select batch to keep</option>
                  {batches.filter((b) => b.status !== 'Merged').map((b) => <option key={b.id} value={b.id}>{b.name} · {centres.find((c) => c.id === b.centre_id)?.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Merge in &amp; archive</label>
                <select value={absorbedId} onChange={(e) => setAbsorbedId(e.target.value)} className={inputClass} disabled={!survivorId}>
                  <option value="">{survivorId ? (mergeCandidates.length ? 'Select batch to merge in' : 'No same-planner batch at this centre') : 'Pick the survivor first'}</option>
                  {mergeCandidates.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>
            {survivorId && absorbedId && (
              <div className="mb-4 text-xs bg-violet-50 border border-violet-200 rounded-lg p-3 text-violet-800">
                Students of <b>{batches.find((b) => b.id === absorbedId)?.name}</b> will move into <b>{batches.find((b) => b.id === survivorId)?.name}</b>. The merged-in batch is archived; its past attendance &amp; results are kept.
              </div>
            )}
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={handleMerge} disabled={merging || !survivorId || !absorbedId}>{merging ? 'Merging…' : 'Merge'}</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setMergeOpen(false)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
