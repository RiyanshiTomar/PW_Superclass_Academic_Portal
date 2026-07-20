'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { checkWeeklyScheduleOverlap, checkClassroomScheduleOverlap } from '@/lib/scheduling'
import { assignPlanner } from '@/lib/planners'
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
type ScheduleRow = {
  faculty_id: string
  subject_id: string
  classroom_id: string
  days: DaySlot[]   // length 7 (Sun..Sat)
}
// A schedule SEGMENT: "from this date to this date, the weekly timetable is
// THIS". The batch's schedule is a list of segments laid end-to-end. One
// segment (blank dates = whole batch) is the simple case; add more to change
// the pattern over time (e.g. Mon/Tue/Wed for the first weeks, then Thu/Fri).
type Segment = {
  from: string
  to: string
  rows: ScheduleRow[]
}

const emptyDays = (): DaySlot[] => Array.from({ length: 7 }, () => ({ active: false, start: '09:00', end: '10:00' }))
const emptyRow = (subjectId = ''): ScheduleRow => ({ subject_id: subjectId, faculty_id: '', classroom_id: '', days: emptyDays() })

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

// Flatten every segment's rows into one row per (active day), stamping the
// segment's date-range onto each.
function flattenSegments(segments: Segment[]): FlatSchedule[] {
  const result: FlatSchedule[] = []
  for (const seg of segments) {
    for (const row of seg.rows) {
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
          effective_from: seg.from || null,
          effective_to: seg.to || null,
        })
      })
    }
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
  const [segments, setSegments] = useState<Segment[]>([])
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

  // Live hours per subject: the COMBINED total across every date range, plus a
  // per-range breakdown. Each range contributes (day duration × how many times
  // that weekday falls inside the range).
  const subjectHours = useMemo(() => {
    const segMeta = segments.map((seg) => ({ from: seg.from || startDate, to: seg.to || endDate }))
    return programSubjects.map((subj) => {
      let minutes = 0
      let lectures = 0
      const bySeg = segments.map((seg, si) => {
        const rf = segMeta[si].from
        const rt = segMeta[si].to
        let min = 0
        let lec = 0
        if (rf && rt) {
          for (const row of seg.rows) {
            if (row.subject_id !== subj.id) continue
            row.days.forEach((d, di) => {
              if (!d.active) return
              const occ = weekdayOccurrences(rf, rt, di)
              lec += occ
              min += occ * Math.max(0, toMinutes(d.end) - toMinutes(d.start))
            })
          }
        }
        minutes += min
        lectures += lec
        return { minutes: min, lectures: lec }
      })
      return { id: subj.id, name: subj.name, lectures, minutes, bySeg }
    })
  }, [segments, startDate, endDate, programSubjects])

  const totalMinutes = useMemo(() => subjectHours.reduce((a, s) => a + s.minutes, 0), [subjectHours])
  const fmtHours = (min: number) => (min / 60).toFixed(min % 60 === 0 ? 0 : 1)

  // Per-segment hours (shown in each segment's header).
  const segmentMinutes = (seg: Segment): number => {
    const rf = seg.from || startDate
    const rt = seg.to || endDate
    if (!rf || !rt) return 0
    let min = 0
    for (const row of seg.rows) {
      if (!row.subject_id) continue
      row.days.forEach((d, di) => { if (d.active) min += weekdayOccurrences(rf, rt, di) * Math.max(0, toMinutes(d.end) - toMinutes(d.start)) })
    }
    return min
  }

  // Which batch dates have NO segment covering them (informational).
  const coverageGap = useMemo(() => {
    if (!startDate || !endDate || segments.length === 0) return null
    const ranges = segments.map((s) => ({ f: s.from || startDate, t: s.to || endDate })).filter((r) => r.f && r.t && r.f <= r.t)
    if (ranges.length === 0) return null
    const d = new Date(startDate + 'T12:00:00')
    const e = new Date(endDate + 'T12:00:00')
    let uncovered = 0
    let firstGap = ''
    while (d <= e) {
      const iso = d.toISOString().split('T')[0]
      if (!ranges.some((r) => iso >= r.f && iso <= r.t)) { uncovered++; if (!firstGap) firstGap = iso }
      d.setDate(d.getDate() + 1)
    }
    return uncovered > 0 ? { uncovered, firstGap } : null
  }, [segments, startDate, endDate])

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

  // Rebuild SEGMENTS from an existing schedule: group slots by their date-range
  // (each range = one segment), then within a segment group by (subject+faculty
  // +room) into rows. A fresh batch gets one whole-batch segment with an empty
  // row per subject.
  const buildSegments = (pid: string, flat: FlatSchedule[] = []): Segment[] => {
    const progSubs = subjects.filter((x) => x.program_id === pid)
    if (flat.length === 0) {
      return [{ from: '', to: '', rows: progSubs.map((s) => emptyRow(s.id)) }]
    }
    const byRange = new Map<string, FlatSchedule[]>()
    for (const f of flat) {
      const k = `${f.effective_from ?? ''}|${f.effective_to ?? ''}`
      if (!byRange.has(k)) byRange.set(k, [])
      byRange.get(k)!.push(f)
    }
    const segs: Segment[] = []
    for (const [k, items] of byRange) {
      const [from, to] = k.split('|')
      const groups = new Map<string, ScheduleRow>()
      for (const f of items) {
        const key = `${f.subject_id ?? ''}|${f.faculty_id ?? ''}|${f.classroom_id ?? ''}`
        if (!groups.has(key)) groups.set(key, { subject_id: f.subject_id ?? '', faculty_id: f.faculty_id ?? '', classroom_id: f.classroom_id || '', days: emptyDays() })
        groups.get(key)!.days[f.day_of_week] = { active: true, start: f.start_time.slice(0, 5), end: f.end_time.slice(0, 5) }
      }
      segs.push({ from, to, rows: Array.from(groups.values()) })
    }
    // Order segments by their start date (blank = whole batch → first).
    segs.sort((a, b) => (a.from || '').localeCompare(b.from || ''))
    return segs
  }

  const handleProgramChange = (pid: string) => {
    setProgramId(pid)
    setSegments(buildSegments(pid))
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
    setSegments((prev) =>
      prev.map((seg) => ({
        ...seg,
        rows: seg.rows.map((row) => {
          // Rooms belong to a centre — clear on centre change so a stale room can't leak across centres.
          let next = { ...row, classroom_id: '' }
          if (!row.faculty_id) return next
          const ids = new Set(userCentres.filter((uc) => uc.centre_id === newCentreId).map((uc) => uc.user_id))
          const fac = faculty.find((f) => f.id === row.faculty_id)
          if (!ids.has(row.faculty_id) && fac?.centre_id !== newCentreId) next = { ...next, faculty_id: '' }
          return next
        }),
      }))
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
    setSegments(buildSegments(b.program_id, (data || []) as FlatSchedule[]))
    setShowForm(true)
    setMessage(null)
  }

  const resetForm = () => {
    setEditingBatch(null)
    setName(''); setProgramId(''); setCentreId(''); setStartDate(''); setEndDate(''); setManagerId('')
    setSegments([])
    setShowForm(false)
    setMessage(null)
  }

  // --- Segment + row mutation helpers ---
  const updateSegment = (si: number, patch: Partial<Pick<Segment, 'from' | 'to'>>) =>
    setSegments((prev) => prev.map((s, i) => (i === si ? { ...s, ...patch } : s)))

  const addSegment = () => setSegments((prev) => {
    const segs = prev.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, days: r.days.map((d) => ({ ...d })) })) }))
    // Going multi-segment: give the first (whole-batch) segment explicit dates.
    if (segs.length === 1 && !segs[0].from && !segs[0].to) { segs[0].from = startDate; segs[0].to = endDate }
    const last = segs[segs.length - 1]
    const lastTo = last?.to || endDate
    const proposedFrom = lastTo && endDate && lastTo < endDate ? addDaysToDate(lastTo, 1) : ''
    segs.push({ from: proposedFrom, to: endDate, rows: [emptyRow(programSubjects[0]?.id ?? '')] })
    return segs
  })

  const removeSegment = (si: number) => setSegments((prev) => prev.filter((_, i) => i !== si))

  const updateRow = (si: number, ri: number, patch: Partial<ScheduleRow>) =>
    setSegments((prev) => prev.map((s, i) => (i !== si ? s : { ...s, rows: s.rows.map((r, j) => (j === ri ? { ...r, ...patch } : r)) })))

  const addRow = (si: number) => setSegments((prev) => prev.map((s, i) => (i !== si ? s : { ...s, rows: [...s.rows, emptyRow(programSubjects[0]?.id ?? '')] })))

  const removeRow = (si: number, ri: number) => setSegments((prev) => prev.map((s, i) => (i !== si ? s : { ...s, rows: s.rows.filter((_, j) => j !== ri) })))

  const toggleDay = (si: number, ri: number, dayIndex: number) => {
    if (!centreId) return
    setSegments((prev) => prev.map((s, i) => (i !== si ? s : {
      ...s,
      rows: s.rows.map((r, j) => (j !== ri ? r : { ...r, days: r.days.map((d, di) => (di === dayIndex ? { ...d, active: !d.active } : d)) })),
    })))
  }

  const updateDayTime = (si: number, ri: number, dayIndex: number, patch: Partial<DaySlot>) => {
    setSegments((prev) => prev.map((s, i) => (i !== si ? s : {
      ...s,
      rows: s.rows.map((r, j) => (j !== ri ? r : { ...r, days: r.days.map((d, di) => (di === dayIndex ? { ...d, ...patch } : d)) })),
    })))
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
    if (segments.length === 0) return fail('Select program & centre to load the schedule.')

    const centreIds = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))

    if (centreClassrooms.length === 0) return fail('This centre has no rooms yet. Add classrooms in Admin → Centres first.')

    const multi = segments.length > 1
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]
      const label = multi ? `Date range ${si + 1}` : 'The schedule'
      // With multiple date ranges, each range must state its own dates.
      if (multi && (!seg.from || !seg.to)) return fail(`${label}: set both a "from" and a "to" date. With more than one date range, each one needs explicit dates.`)
      if (seg.from && (seg.from < startDate || seg.from > endDate)) return fail(`${label}: the "from" date must be within the batch (${startDate} to ${endDate}).`)
      if (seg.to && (seg.to < startDate || seg.to > endDate)) return fail(`${label}: the "to" date must be within the batch (${startDate} to ${endDate}).`)
      const segFrom = seg.from || startDate
      const segTo = seg.to || endDate
      if (segFrom > segTo) return fail(`${label}: the "from" date is after the "to" date. Please fix it.`)
      if (seg.rows.length === 0) return fail(`${label}: add at least one class.`)

      for (let idx = 0; idx < seg.rows.length; idx++) {
        const row = seg.rows[idx]
        const where = `${label}, class ${idx + 1}`
        if (!row.subject_id) return fail(`${where}: pick a subject.`)
        const sName = subjName(row.subject_id)
        if (!row.faculty_id) return fail(`${where} ("${sName}"): assign a faculty.`)
        if (!row.classroom_id) return fail(`${where} ("${sName}"): pick a classroom. Every class needs a room.`)
        if (!centreClassrooms.some((c) => c.id === row.classroom_id)) return fail(`${where} ("${sName}"): the chosen room is not at this centre.`)
        const activeDays = row.days.map((d, di) => ({ ...d, di })).filter((d) => d.active)
        if (activeDays.length === 0) return fail(`${where} ("${sName}"): pick at least one day.`)
        for (const d of activeDays) {
          const timeErr = validateTimeRange(d.start, d.end)
          if (timeErr) return fail(`${where} ("${sName}") · ${DAYS[d.di]}: ${timeErr}`)
          if (weekdayOccurrences(segFrom, segTo, d.di) === 0) return fail(`${where} ("${sName}"): ${DAYS[d.di]} never occurs between ${segFrom} and ${segTo}. Remove ${DAYS[d.di]} or widen this date range.`)
        }
        const fac = faculty.find((f) => f.id === row.faculty_id)
        if (!centreIds.has(row.faculty_id) && fac?.centre_id !== centreId) return fail(`${where}: ${fac?.full_name ?? 'that faculty'} does not teach at this centre.`)
      }
    }

    // Every subject of the program must appear in at least one date range.
    const covered = new Set(segments.flatMap((s) => s.rows.map((r) => r.subject_id)))
    const missing = programSubjects.filter((s) => !covered.has(s.id))
    if (missing.length > 0) return fail(`No class yet for: ${missing.map((s) => s.name).join(', ')}. Every subject needs at least one class (in any date range).`)

    const flat = flattenSegments(segments)

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
        const rows = flat.map((s) => ({ batch_id: batchId, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, faculty_id: s.faculty_id, subject_id: s.subject_id, classroom_id: s.classroom_id, effective_from: s.effective_from, effective_to: s.effective_to }))
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
                  Each <span className="font-semibold text-neutral-700">date range</span> holds a weekly timetable that runs for those dates. Keep one range for the whole batch, or add more so the pattern can change over time (e.g. <span className="font-medium">20 Jul → 1 Aug: Mon/Tue/Wed</span>, then <span className="font-medium">2 Aug → 20 Aug: Thu/Wed/Fri</span>). All <span className="font-semibold text-violet-600">{programSubjects.length} subjects</span> must appear in at least one range; overlaps are always blocked. ({centreFaculty.length} faculty · {centreClassrooms.length} room{centreClassrooms.length === 1 ? '' : 's'} at {centres.find((c) => c.id === centreId)?.name})
                </p>

                {segments.map((seg, si) => {
                  const multi = segments.length > 1
                  const dateInput = 'h-9 px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
                  return (
                  <div key={si} className="mb-5 border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="bg-violet-50/60 border-b border-neutral-200 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-violet-700">{multi ? `Date range ${si + 1}` : 'Schedule'}</span>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-neutral-500">From</label>
                        <input type="date" value={seg.from} min={startDate || undefined} max={endDate || undefined} onChange={(e) => updateSegment(si, { from: e.target.value })} className={dateInput} />
                        <label className="text-xs text-neutral-500">to</label>
                        <input type="date" value={seg.to} min={seg.from || startDate || undefined} max={endDate || undefined} onChange={(e) => updateSegment(si, { to: e.target.value })} className={dateInput} />
                        {!seg.from && !seg.to && <span className="text-xs text-neutral-400">(whole batch)</span>}
                      </div>
                      <span className="ml-auto text-xs font-bold text-violet-700">{fmtHours(segmentMinutes(seg))} hrs</span>
                      {multi && <button type="button" onClick={() => removeSegment(si)} className="text-xs font-semibold text-red-600 hover:text-red-700">Remove range</button>}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[860px]">
                        <thead>
                          <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                            <th className="text-left px-4 py-2.5 font-semibold min-w-[150px]">Subject *</th>
                            <th className="text-left px-3 py-2.5 font-semibold min-w-[160px]">Faculty *</th>
                            <th className="text-left px-3 py-2.5 font-semibold min-w-[150px]">Classroom *</th>
                            <th className="text-left px-3 py-2.5 font-semibold min-w-[300px]">Days &amp; Timings *</th>
                            <th className="w-8" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100">
                          {seg.rows.map((row, ri) => {
                            const filled = row.subject_id && row.faculty_id && row.classroom_id && row.days.some((d) => d.active)
                            const subjectFaculty = row.subject_id ? facultyForSubject(row.subject_id) : centreFaculty
                            return (
                            <tr key={ri} className={filled ? '' : 'bg-amber-50/40'}>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className={`h-2 w-2 rounded-full shrink-0 ${filled ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                                  <select value={row.subject_id} onChange={(e) => updateRow(si, ri, { subject_id: e.target.value, faculty_id: '' })} className={inputClass}>
                                    <option value="">Select subject</option>
                                    {programSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                  </select>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <select value={row.faculty_id} onChange={(e) => updateRow(si, ri, { faculty_id: e.target.value })} className={inputClass} disabled={subjectFaculty.length === 0}>
                                  <option value="">{subjectFaculty.length === 0 ? 'No faculty at this centre' : row.subject_id ? 'Select faculty (for this subject)' : 'Pick a subject first'}</option>
                                  {subjectFaculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                                </select>
                              </td>
                              <td className="px-3 py-3">
                                <select value={row.classroom_id} onChange={(e) => updateRow(si, ri, { classroom_id: e.target.value })} className={inputClass} disabled={centreClassrooms.length === 0}>
                                  <option value="">{centreClassrooms.length === 0 ? 'No rooms at centre' : 'Select room'}</option>
                                  {centreClassrooms.map((c) => <option key={c.id} value={c.id}>{c.room_no ? `${c.room_no} · ${c.name}` : c.name}</option>)}
                                </select>
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex flex-wrap gap-1 mb-1.5">
                                  {DAYS.map((d, dayIndex) => (
                                    <button key={dayIndex} type="button" onClick={() => toggleDay(si, ri, dayIndex)} className={`w-9 h-8 rounded-lg border text-[11px] font-bold transition-colors ${row.days[dayIndex].active ? 'bg-violet-500 text-white border-violet-600' : 'bg-white text-neutral-400 border-neutral-200 hover:border-neutral-400'}`}>{d}</button>
                                  ))}
                                </div>
                                <div className="space-y-1">
                                  {row.days.some((d) => d.active) ? row.days.map((d, dayIndex) => d.active && (
                                    <div key={dayIndex} className="flex items-center gap-2 text-xs">
                                      <span className="w-9 font-semibold text-neutral-500">{DAYS[dayIndex]}</span>
                                      <input type="time" value={d.start} onChange={(e) => updateDayTime(si, ri, dayIndex, { start: e.target.value })} className="h-8 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                      <span className="text-neutral-400">–</span>
                                      <input type="time" value={d.end} onChange={(e) => updateDayTime(si, ri, dayIndex, { end: e.target.value })} className="h-8 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                    </div>
                                  )) : <span className="text-[11px] text-neutral-400">Pick day(s) above, then set each day&apos;s time.</span>}
                                </div>
                              </td>
                              <td className="px-2 py-3 text-center align-top">
                                <button type="button" onClick={() => removeRow(si, ri)} title="Remove this class" className="text-neutral-300 hover:text-red-600 text-xl leading-none">×</button>
                              </td>
                            </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-4 py-2 border-t border-neutral-100 bg-neutral-50/40">
                      <button type="button" onClick={() => addRow(si)} className="inline-flex items-center gap-1 text-sm font-semibold text-violet-600 hover:text-violet-700">+ Add a class to this range</button>
                    </div>
                  </div>
                  )
                })}

                <button type="button" onClick={addSegment} className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-600 hover:text-violet-700 border border-dashed border-violet-300 rounded-lg px-4 py-2">
                  + Add another date range
                </button>

                {coverageGap && (
                  <Alert type="info">These batch dates have no schedule yet (starting {new Date(coverageGap.firstGap + 'T12:00:00').toLocaleDateString()}) — {coverageGap.uncovered} day{coverageGap.uncovered === 1 ? '' : 's'} uncovered. That&apos;s fine if intended (breaks/holidays); otherwise widen a date range to cover start → end.</Alert>
                )}

                {startDate && endDate && (
                  <div className="mb-8 border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="bg-neutral-50 px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-600">Total hours per subject <span className="normal-case font-normal text-neutral-400">· all date ranges combined · {new Date(startDate + 'T12:00:00').toLocaleDateString()} → {new Date(endDate + 'T12:00:00').toLocaleDateString()}</span></h4>
                      <span className="text-xs font-bold text-violet-700">{fmtHours(totalMinutes)} hrs total</span>
                    </div>
                    <div className="divide-y divide-neutral-100">
                      {subjectHours.map((s) => {
                        const active = s.bySeg.map((b, i) => ({ ...b, i })).filter((b) => b.minutes > 0)
                        return (
                        <div key={s.id} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                          <span className="text-neutral-700 pt-0.5">{s.name}</span>
                          <div className="text-right">
                            <div className={s.lectures === 0 ? 'text-amber-600' : 'text-neutral-500'}>
                              {s.lectures} lecture{s.lectures === 1 ? '' : 's'} · <b className="text-neutral-800">{fmtHours(s.minutes)} hrs</b>
                            </div>
                            {segments.length > 1 && active.length > 0 && (
                              <div className="text-[11px] text-neutral-400 mt-0.5">
                                {active.map((b) => `Range ${b.i + 1}: ${fmtHours(b.minutes)}h`).join('  +  ')}
                              </div>
                            )}
                          </div>
                        </div>
                        )
                      })}
                    </div>
                    <p className="px-4 py-2 text-[11px] text-neutral-400 bg-neutral-50/60">Live estimate: for each subject, every date range&apos;s hours are added up. Updates as you edit.</p>
                  </div>
                )}
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
