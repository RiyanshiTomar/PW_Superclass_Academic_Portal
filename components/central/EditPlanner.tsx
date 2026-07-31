'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { rematerialiseLink } from '@/lib/planners'
import { fetchMaster, type Master } from '@/lib/syllabus'
import { toMinutes } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card } from '@/components/PortalShell'

type Planner = { id: string; name: string; program_id: string | null }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type LinkLite = { id: string; stage: string; batch_id?: string; batches: { name: string } | { name: string }[] | null }
type Status = 'planned' | 'confirmed' | 'conducted'
type EditRow = {
  key: string
  subject_id: string
  faculty_id: string
  chapter: string       // locked (concept tag)
  topic_name: string    // editable
  planned_date: string
  duration_minutes: number
  status: Status
  db_id?: string        // batch_planners row id — set only in LIVE (batch) mode
  stage?: string        // batch_planners.stage — shown read-only in LIVE mode
}
// Buffer / empty template rows are preserved untouched (not shown in this board).
type Keep = { subject_id: string | null; faculty_id: string | null; chapter: string; topic_name: string; planned_date: string; start_time: string | null; duration_minutes: number; is_buffer: boolean; status: string }

function batchName(v: LinkLite['batches']): string {
  if (!v) return 'Batch'
  return Array.isArray(v) ? v[0]?.name ?? 'Batch' : v.name ?? 'Batch'
}
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().replace(/s$/, '')
const fmtDate = (d: string) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—')
// Edit Planner shows the COMPLETE planner with its real dates (past + future);
// central marks each class Confirmed / Already-conducted (with its final date).

export default function EditPlanner() {
  const supabase = createClient()
  const keySeq = useRef(0)
  const nextKey = () => `r${keySeq.current++}`

  const [planners, setPlanners] = useState<Planner[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([])
  const [batchList, setBatchList] = useState<{ id: string; name: string; centre_id: string }[]>([])
  const [plannerLinks, setPlannerLinks] = useState<{ planner_id: string; batch_id: string }[]>([])
  const [filterCentre, setFilterCentre] = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [rows, setRows] = useState<EditRow[]>([])
  const [keptBuffers, setKeptBuffers] = useState<Keep[]>([])
  const [links, setLinks] = useState<LinkLite[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [master, setMaster] = useState<Master | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // LIVE (per-batch) mode: when a batch is picked, we edit that batch's
  // materialised planner (batch_planners) — which reflects faculty-approved
  // reschedules / prepones / cancellations — instead of the shared template.
  const [liveLinkId, setLiveLinkId] = useState('')
  const [liveStage, setLiveStage] = useState('')
  const [liveBatchLabel, setLiveBatchLabel] = useState('')
  const [liveHasStatus, setLiveHasStatus] = useState(false)
  const liveOrigIdsRef = useRef<Set<string>>(new Set())
  const liveSlotByDateRef = useRef<Map<string, { start_time: string | null; classroom_id: string | null; duration: number }>>(new Map())
  // For safe "+ add row" in live mode: the batch's weekly slots per subject,
  // its date bounds, and the dates/times tests occupy — so a new row lands on a
  // genuinely free class-date (no lecture, no test) and never overlaps.
  const liveSchedRef = useRef<Map<string, Map<number, { start: string; duration: number; classroom: string | null }>>>(new Map())
  const liveTestsRef = useRef<Map<string, [number, number][]>>(new Map())
  const liveBoundsRef = useRef<{ start: string; end: string }>({ start: '', end: '' })

  const [activeSubject, setActiveSubject] = useState('')
  const [search, setSearch] = useState('')
  const [reorderMode, setReorderMode] = useState<'rows' | 'chapters'>('rows')
  const dragKeyRef = useRef<string | null>(null)
  const dragChapterRef = useRef<string | null>(null)
  // "Already conducted" date dialog
  const [conductKey, setConductKey] = useState<string | null>(null)
  const [conductDate, setConductDate] = useState('')

  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [confirmDate, setConfirmDate] = useState('')

  const selected = planners.find((p) => p.id === selectedId) ?? null
  const todayISO = new Date().toISOString().split('T')[0]

  const topicOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.flatMap((c) => c.topics)))) : []), [master])
  const masterMap = useMemo(() => {
    const m = new Map<string, Map<string, Set<string>>>()
    for (const s of master?.subjects ?? []) {
      const cm = new Map<string, Set<string>>()
      for (const c of s.chapters) cm.set(norm(c.name), new Set(c.topics.map((t) => norm(t))))
      m.set(s.id, cm)
    }
    return m
  }, [master])

  const subjName = (id: string) => subjects.find((s) => s.id === id)?.name ?? '—'
  const facName = (id: string) => faculty.find((f) => f.id === id)?.full_name ?? ''

  // Centre → batch → planner filtering (only that batch's planner in the picker).
  const batchesForCentre = useMemo(() => (filterCentre ? batchList.filter((b) => b.centre_id === filterCentre) : batchList), [batchList, filterCentre])
  const centreOfBatch = useMemo(() => new Map(batchList.map((b) => [b.id, b.centre_id])), [batchList])
  const batchesByPlanner = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of plannerLinks) { if (!m.has(l.planner_id)) m.set(l.planner_id, new Set()); m.get(l.planner_id)!.add(l.batch_id) }
    return m
  }, [plannerLinks])
  const plannersShown = useMemo(() => planners.filter((p) => {
    const bs = batchesByPlanner.get(p.id) ?? new Set<string>()
    if (filterBatch) return bs.has(filterBatch)
    if (filterCentre) return Array.from(bs).some((bid) => centreOfBatch.get(bid) === filterCentre)
    return true
  }), [planners, batchesByPlanner, filterBatch, filterCentre, centreOfBatch])

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [planRes, subjRes, facRes, centRes, batchRes, linkRes] = await Promise.all([
        supabase.from('planners').select('id, name, program_id').order('created_at', { ascending: false }),
        supabase.from('subjects').select('id, name, program_id').order('name'),
        supabase.rpc('list_active_faculty', { p_centre_id: null }),
        supabase.from('centres').select('id, name').order('name'),
        supabase.from('batches').select('id, name, centre_id').neq('status', 'Merged').order('name'),
        supabase.from('batch_planner_links').select('planner_id, batch_id'),
      ])
      if (planRes.data) setPlanners(planRes.data as Planner[])
      if (subjRes.data) setSubjects(subjRes.data as Subject[])
      if (facRes.data) setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
      if (centRes.data) setCentres(centRes.data as { id: string; name: string }[])
      if (batchRes.data) setBatchList(batchRes.data as { id: string; name: string; centre_id: string }[])
      if (linkRes.data) setPlannerLinks(linkRes.data as { planner_id: string; batch_id: string }[])
      setLoading(false)
    }
    load()
  }, [])

  const selectPlanner = async (id: string) => {
    setSelectedId(id); setMessage(null); setSearch('')
    if (!id) { setRows([]); setKeptBuffers([]); setLinks([]); setMaster(null); setActiveSubject(''); setLiveLinkId(''); setLiveStage(''); setLiveBatchLabel(''); return }
    const prog = planners.find((p) => p.id === id)?.program_id ?? null
    fetchMaster(supabase, prog ?? '').then(setMaster)
    const linkRes = await supabase.from('batch_planner_links').select('id, stage, batch_id, batches(name)').eq('planner_id', id)
    const linksData = (linkRes.data ?? []) as unknown as LinkLite[]
    setLinks(linksData)

    // If a specific batch is chosen and this planner is linked to it → LIVE mode.
    const liveLink = filterBatch ? linksData.find((l) => l.batch_id === filterBatch) : undefined
    if (liveLink) {
      setLiveLinkId(liveLink.id); setLiveStage(liveLink.stage); setLiveBatchLabel(batchName(liveLink.batches))
      await loadLiveRows(liveLink.id)
    } else {
      setLiveLinkId(''); setLiveStage(''); setLiveBatchLabel('')
      await loadTemplateRows(id)
    }
  }

  // Paginate a select, falling back to a column set without `status` if absent.
  type PgRes = { data: unknown[] | null; error: { message: string } | null }
  const paginate = async (table: string, cols: string, colsNoStatus: string, plannerCol: string, plannerVal: string): Promise<{ rows: Record<string, unknown>[]; hasStatus: boolean; error?: string }> => {
    let useCols = cols
    let hasStatus = true
    const out: Record<string, unknown>[] = []
    const fetchPage = (c: string, from: number) => supabase.from(table).select(c).eq(plannerCol, plannerVal).order('planned_date', { ascending: true }).range(from, from + 999) as unknown as Promise<PgRes>
    for (let from = 0; from < 20000; from += 1000) {
      let res = await fetchPage(useCols, from)
      if (res.error && useCols === cols) { useCols = colsNoStatus; hasStatus = false; res = await fetchPage(colsNoStatus, from) }
      if (res.error) { if (from === 0) return { rows: [], hasStatus: false, error: res.error.message }; break }
      const chunk = (res.data ?? []) as Record<string, unknown>[]
      out.push(...chunk)
      if (chunk.length < 1000) break
    }
    return { rows: out, hasStatus }
  }

  // TEMPLATE mode — the shared blueprint (planner_lectures).
  const loadTemplateRows = async (id: string) => {
    const { rows: lecData, error } = await paginate('planner_lectures', 'subject_id, faculty_id, chapter, topic_name, planned_date, duration_minutes, is_buffer, status', 'subject_id, faculty_id, chapter, topic_name, planned_date, duration_minutes, is_buffer', 'planner_id', id)
    if (error) { setMessage({ type: 'error', text: `Could not load the planner: ${error}` }); return }
    const real: EditRow[] = []
    const buffers: Keep[] = []
    for (const l of lecData) {
      const chapter = (l.chapter as string) ?? ''
      const topic = (l.topic_name as string) ?? ''
      if (chapter.trim() && topic.trim()) {
        real.push({
          key: nextKey(),
          subject_id: (l.subject_id as string) ?? '',
          faculty_id: (l.faculty_id as string) ?? '',
          chapter, topic_name: topic,
          planned_date: (l.planned_date as string) ?? '',
          duration_minutes: (l.duration_minutes as number) ?? 60,
          status: (['planned', 'confirmed', 'conducted'].includes(l.status as string) ? l.status : 'planned') as Status,
        })
      } else {
        buffers.push({ subject_id: (l.subject_id as string) ?? null, faculty_id: (l.faculty_id as string) ?? null, chapter, topic_name: topic, planned_date: (l.planned_date as string) ?? '', start_time: null, duration_minutes: (l.duration_minutes as number) ?? 60, is_buffer: (l.is_buffer as boolean) ?? true, status: (l.status as string) ?? 'planned' })
      }
    }
    liveOrigIdsRef.current = new Set(); liveSlotByDateRef.current = new Map()
    setRows(real); setKeptBuffers(buffers)
    setActiveSubject(real[0]?.subject_id ?? '')
  }

  // LIVE mode — this batch's materialised planner (batch_planners), which
  // already reflects faculty-approved reschedules / prepones / cancellations.
  const loadLiveRows = async (linkId: string) => {
    const { rows: lecData, hasStatus, error } = await paginate('batch_planners', 'id, subject_id, faculty_id, chapter, topic_name, planned_date, start_time, duration_minutes, is_buffer, classroom_id, stage, status', 'id, subject_id, faculty_id, chapter, topic_name, planned_date, start_time, duration_minutes, is_buffer, classroom_id, stage', 'link_id', linkId)
    if (error) { setMessage({ type: 'error', text: `Could not load the batch schedule: ${error}` }); return }
    setLiveHasStatus(hasStatus)
    const real: EditRow[] = []
    const origIds = new Set<string>()
    const slotByDate = new Map<string, { start_time: string | null; classroom_id: string | null; duration: number }>()
    for (const l of lecData) {
      const date = (l.planned_date as string) ?? ''
      // Every dated slot carries its inherited time/room — key by date so a
      // reorder (which only permutes existing dates) keeps the right slot.
      if (date && !slotByDate.has(date)) slotByDate.set(date, { start_time: (l.start_time as string) ?? null, classroom_id: (l.classroom_id as string) ?? null, duration: (l.duration_minutes as number) ?? 60 })
      const chapter = (l.chapter as string) ?? ''
      const topic = (l.topic_name as string) ?? ''
      const isBuffer = (l.is_buffer as boolean) ?? false
      // Buffers stay untouched in the DB (we never load them for edit, so a
      // per-row save can't disturb them).
      if (isBuffer || !chapter.trim()) continue
      const id = l.id as string
      origIds.add(id)
      real.push({
        key: nextKey(), db_id: id,
        subject_id: (l.subject_id as string) ?? '',
        faculty_id: (l.faculty_id as string) ?? '',
        chapter, topic_name: topic,
        planned_date: date,
        duration_minutes: (l.duration_minutes as number) ?? 60,
        status: (hasStatus && ['planned', 'confirmed', 'conducted'].includes(l.status as string) ? l.status : 'planned') as Status,
        stage: (l.stage as string) ?? '',
      })
    }
    liveOrigIdsRef.current = origIds
    liveSlotByDateRef.current = slotByDate

    // Extra context for safe "+ add row": weekly slots per subject, test-busy
    // dates, and the batch's date bounds.
    const [schedRes, testRes, batchRes] = await Promise.all([
      supabase.from('batch_schedules').select('subject_id, day_of_week, start_time, end_time, classroom_id').eq('batch_id', filterBatch),
      supabase.from('test_schedules').select('test_date, start_time, duration_minutes').eq('batch_id', filterBatch),
      supabase.from('batches').select('start_date, end_date').eq('id', filterBatch).single<{ start_date: string; end_date: string }>(),
    ])
    const sched = new Map<string, Map<number, { start: string; duration: number; classroom: string | null }>>()
    for (const s of (schedRes.data ?? []) as { subject_id: string | null; day_of_week: number; start_time: string; end_time: string; classroom_id: string | null }[]) {
      if (!s.subject_id) continue
      if (!sched.has(s.subject_id)) sched.set(s.subject_id, new Map())
      const m = sched.get(s.subject_id)!
      if (!m.has(s.day_of_week)) m.set(s.day_of_week, { start: s.start_time.slice(0, 5), duration: toMinutes(s.end_time.slice(0, 5)) - toMinutes(s.start_time.slice(0, 5)), classroom: s.classroom_id ?? null })
    }
    const testsByDate = new Map<string, [number, number][]>()
    for (const t of (testRes.data ?? []) as { test_date: string; start_time: string; duration_minutes: number }[]) {
      const ts = toMinutes(t.start_time.slice(0, 5)); const arr = testsByDate.get(t.test_date) ?? []
      arr.push([ts, ts + t.duration_minutes]); testsByDate.set(t.test_date, arr)
    }
    liveSchedRef.current = sched
    liveTestsRef.current = testsByDate
    liveBoundsRef.current = { start: batchRes.data?.start_date ?? todayISO, end: batchRes.data?.end_date ?? todayISO }

    setRows(real); setKeptBuffers([])
    setActiveSubject(real[0]?.subject_id ?? '')
  }

  // Subjects present in the planner (tabs).
  const subjectTabs = useMemo(() => {
    const ids = Array.from(new Set(rows.map((r) => r.subject_id)))
    return ids.map((id) => ({ id, name: subjName(id) })).sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, subjects])

  useEffect(() => {
    if (subjectTabs.length && !subjectTabs.some((t) => t.id === activeSubject)) setActiveSubject(subjectTabs[0].id)
  }, [subjectTabs, activeSubject])

  // After-today summary for the active subject.
  const summary = useMemo(() => {
    const left = rows.filter((r) => r.subject_id === activeSubject && r.status !== 'conducted' && r.planned_date >= todayISO)
    const mins = left.reduce((a, r) => a + (r.duration_minutes || 60), 0)
    const done = rows.filter((r) => r.subject_id === activeSubject && r.status === 'conducted').length
    return { lecturesLeft: left.length, hoursLeft: mins / 60, conducted: done }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeSubject])

  // Rows for the active subject, filtered by search (teacher / topic / chapter),
  // grouped by chapter; chapters ordered by their earliest date, rows by date.
  const chapterGroups = useMemo(() => {
    const q = search.toLowerCase().trim()
    const list = rows.filter((r) => r.subject_id === activeSubject && (!q || facName(r.faculty_id).toLowerCase().includes(q) || r.topic_name.toLowerCase().includes(q) || r.chapter.toLowerCase().includes(q)))
    const byChap = new Map<string, EditRow[]>()
    for (const r of list) { if (!byChap.has(r.chapter)) byChap.set(r.chapter, []); byChap.get(r.chapter)!.push(r) }
    const groups = Array.from(byChap.entries()).map(([chapter, rs]) => ({ chapter, rows: [...rs].sort((a, b) => a.planned_date.localeCompare(b.planned_date)) }))
    groups.sort((a, b) => (a.rows[0]?.planned_date ?? '').localeCompare(b.rows[0]?.planned_date ?? ''))
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeSubject, search, faculty])

  // Re-assign the subject's upcoming (non-conducted) dates in ascending order to
  // the rows in their current array order — so date always follows position.
  // Re-assign the subject's upcoming (non-conducted) dates in ascending order to
  // the rows in their current array order — so date follows drag position. SAFE:
  // only PERMUTES the existing dates (never invents new far-future dates, which
  // used to scramble the plan). If a row has no slot (after Add), it reuses the
  // last existing date (a harmless duplicate) rather than drifting by a month.
  const relayer = (all: EditRow[], subjectId: string): EditRow[] => {
    const upcoming = all.filter((r) => r.subject_id === subjectId && r.status !== 'conducted')
    const slots = upcoming.map((r) => r.planned_date).filter(Boolean).sort()
    while (slots.length < upcoming.length) slots.push(slots[slots.length - 1] || todayISO)
    let i = 0
    const dateByKey = new Map<string, string>()
    for (const r of upcoming) { dateByKey.set(r.key, slots[i] ?? todayISO); i++ }
    return all.map((r) => (dateByKey.has(r.key) ? { ...r, planned_date: dateByKey.get(r.key)! } : r))
  }

  const updateRow = (key: string, patch: Partial<EditRow>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const addRowToChapter = (subjectId: string, chapter: string) => {
    setRows((prev) => {
      const sample = prev.find((r) => r.subject_id === subjectId && r.chapter === chapter)
      // New row takes the chapter's last date (or the subject's last) — a harmless
      // duplicate that sorts adjacent. NO month-gap invention (that scrambled plans).
      const chapDates = prev.filter((r) => r.subject_id === subjectId && r.chapter === chapter).map((r) => r.planned_date).filter(Boolean).sort()
      const upDates = prev.filter((r) => r.subject_id === subjectId && r.status !== 'conducted').map((r) => r.planned_date).filter(Boolean).sort()
      const newDate = chapDates[chapDates.length - 1] || upDates[upDates.length - 1] || todayISO
      const newRow: EditRow = { key: nextKey(), subject_id: subjectId, faculty_id: sample?.faculty_id ?? '', chapter, topic_name: '', planned_date: newDate, duration_minutes: sample?.duration_minutes ?? 60, status: 'planned' }
      // insert after the chapter's last row (no re-shuffle of other dates)
      let idx = -1
      prev.forEach((r, i) => { if (r.subject_id === subjectId && r.chapter === chapter) idx = i })
      const next = [...prev]
      next.splice(idx + 1, 0, newRow)
      return next
    })
  }

  // LIVE mode add: land the new class on the subject's NEXT free class-date —
  // one with no existing lecture and no test — so it can never overlap.
  const liveAddRow = (subjectId: string, chapter: string) => {
    const sched = liveSchedRef.current.get(subjectId)
    const used = new Set(rows.filter((r) => r.subject_id === subjectId).map((r) => r.planned_date))
    let newDate = ''
    let slotInfo = { start_time: null as string | null, classroom_id: null as string | null, duration: 60 }
    if (sched && sched.size) {
      const testFree = (date: string, slot: { start: string; duration: number }) => {
        const s = toMinutes(slot.start), e = s + slot.duration
        return !(liveTestsRef.current.get(date) ?? []).some(([ts, te]) => s < te && e > ts)
      }
      const from = liveBoundsRef.current.start > todayISO ? liveBoundsRef.current.start : todayISO
      const d = new Date(from + 'T12:00:00')
      const end = new Date(liveBoundsRef.current.end + 'T12:00:00'); end.setDate(end.getDate() + 180)
      while (d <= end) {
        const dateStr = d.toISOString().split('T')[0]
        const slot = sched.get(d.getDay())
        if (slot && !used.has(dateStr) && testFree(dateStr, slot)) { newDate = dateStr; slotInfo = { start_time: slot.start, classroom_id: slot.classroom, duration: slot.duration }; break }
        d.setDate(d.getDate() + 1)
      }
    }
    if (!newDate) { setMessage({ type: 'info', text: 'No free class-date to add this class without an overlap. Reschedule an existing lecture instead, or add the subject’s weekly slot first.' }); return }
    liveSlotByDateRef.current.set(newDate, slotInfo)
    setRows((prev) => {
      const sample = prev.find((r) => r.subject_id === subjectId && r.chapter === chapter)
      const newRow: EditRow = { key: nextKey(), subject_id: subjectId, faculty_id: sample?.faculty_id ?? '', chapter, topic_name: '', planned_date: newDate, duration_minutes: slotInfo.duration, status: 'planned' }
      let idx = -1
      prev.forEach((r, i) => { if (r.subject_id === subjectId && r.chapter === chapter) idx = i })
      const next = [...prev]; next.splice(idx + 1, 0, newRow); return next
    })
    setMessage({ type: 'success', text: `Added a class on ${fmtDate(newDate)} — the next free slot for ${subjName(subjectId)} (no overlap).` })
  }

  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  const setStatus = (key: string, status: Status) => {
    if (status === 'conducted') {
      const r = rows.find((x) => x.key === key)
      setConductKey(key); setConductDate(r?.planned_date && r.planned_date <= todayISO ? r.planned_date : todayISO)
      return
    }
    if (status === 'confirmed') {
      const r = rows.find((x) => x.key === key)
      setConfirmKey(key); setConfirmDate(r?.planned_date ?? todayISO)
      return
    }
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, status } : r)))
  }

  const resolveLiveSlot = (subjectId: string, faculty_id: string, date: string, excludeKey: string): { ok: boolean; error?: string } => {
    if (!liveLinkId) return { ok: true }

    let slot = liveSlotByDateRef.current.get(date)
    if (!slot) {
      const sched = liveSchedRef.current.get(subjectId)
      const dow = new Date(date + 'T12:00:00').getDay()
      const weekly = sched?.get(dow)
      if (!weekly) return { ok: false, error: `No weekly class for ${subjName(subjectId)} on that day.` }
      slot = { start_time: weekly.start, classroom_id: weekly.classroom, duration: weekly.duration }
      liveSlotByDateRef.current.set(date, slot)
    }
    if (!slot.start_time) return { ok: true }

    const start = toMinutes(slot.start_time.slice(0, 5))
    const end = start + slot.duration

    const testHit = (liveTestsRef.current.get(date) ?? []).some(([ts, te]) => start < te && end > ts)
    if (testHit) return { ok: false, error: `A test is already scheduled in this slot on ${fmtDate(date)}.` }

    if (faculty_id) {
      for (const other of rows) {
        if (other.key === excludeKey || other.faculty_id !== faculty_id || other.planned_date !== date) continue
        const otherSlot = liveSlotByDateRef.current.get(other.planned_date) ?? (() => {
          const sched = liveSchedRef.current.get(other.subject_id)
          const dow = new Date(other.planned_date + 'T12:00:00').getDay()
          const w = sched?.get(dow)
          return w ? { start_time: w.start, classroom_id: w.classroom, duration: w.duration } : null
        })()
        if (!otherSlot?.start_time) continue
        const os = toMinutes(otherSlot.start_time.slice(0, 5))
        const oe = os + otherSlot.duration
        if (start < oe && end > os) return { ok: false, error: `${facName(faculty_id)} already has ${subjName(other.subject_id)} at an overlapping time on ${fmtDate(date)}.` }
      }
    }
    return { ok: true }
  }

  const applyConducted = () => {
    if (!conductKey || !conductDate) return
    const r = rows.find((x) => x.key === conductKey)
    if (r && conductDate !== r.planned_date) {
      const check = resolveLiveSlot(r.subject_id, r.faculty_id, conductDate, conductKey)
      if (!check.ok) { setMessage({ type: 'error', text: check.error ?? 'That date conflicts with an existing class.' }); return }
    }
    setRows((prev) => prev.map((row) => (row.key === conductKey ? { ...row, status: 'conducted' as Status, planned_date: conductDate } : row)))
    setConductKey(null); setConductDate('')
  }

  const applyConfirmed = () => {
    if (!confirmKey || !confirmDate) return
    const r = rows.find((x) => x.key === confirmKey)
    if (r && confirmDate !== r.planned_date) {
      const check = resolveLiveSlot(r.subject_id, r.faculty_id, confirmDate, confirmKey)
      if (!check.ok) { setMessage({ type: 'error', text: check.error ?? 'That date conflicts with an existing class.' }); return }
    }
    setRows((prev) => prev.map((row) => (row.key === confirmKey ? { ...row, status: 'confirmed' as Status, planned_date: confirmDate } : row)))
    setConfirmKey(null); setConfirmDate('')
  }

  // --- Drag reorder ---
  const onRowDrop = (targetKey: string) => {
    const dragKey = dragKeyRef.current
    dragKeyRef.current = null
    if (!dragKey || dragKey === targetKey) return
    setRows((prev) => {
      const drag = prev.find((r) => r.key === dragKey)
      const target = prev.find((r) => r.key === targetKey)
      if (!drag || !target || drag.subject_id !== target.subject_id || drag.chapter !== target.chapter || drag.status === 'conducted' || target.status === 'conducted') return prev
      // Reorder ONLY within this chapter's non-conducted rows, and permute their
      // OWN dates onto the new order (never touches other chapters/subjects, never
      // invents dates). This is the safe replacement for the old subject-wide relayer.
      const chapRows = prev.filter((r) => r.subject_id === drag.subject_id && r.chapter === drag.chapter && r.status !== 'conducted').sort((a, b) => a.planned_date.localeCompare(b.planned_date))
      const order = chapRows.map((r) => r.key).filter((k) => k !== dragKey)
      const ti = order.indexOf(targetKey)
      order.splice(ti < 0 ? order.length : ti, 0, dragKey)
      const dates = chapRows.map((r) => r.planned_date).sort()
      const dateByKey = new Map(order.map((k, i) => [k, dates[i] ?? dates[dates.length - 1]]))
      return prev.map((r) => (dateByKey.has(r.key) ? { ...r, planned_date: dateByKey.get(r.key)! } : r))
    })
  }

  const onChapterDrop = (targetChapter: string) => {
    const dragChap = dragChapterRef.current
    dragChapterRef.current = null
    if (!dragChap || dragChap === targetChapter) return
    setRows((prev) => {
      const moving = prev.filter((r) => r.subject_id === activeSubject && r.chapter === dragChap)
      if (moving.length === 0) return prev
      const rest = prev.filter((r) => !(r.subject_id === activeSubject && r.chapter === dragChap))
      // insert moving block before the first row of the target chapter
      const ti = rest.findIndex((r) => r.subject_id === activeSubject && r.chapter === targetChapter)
      if (ti < 0) return prev
      rest.splice(ti, 0, ...moving)
      return relayer(rest, activeSubject)
    })
  }

  const handleSave = async () => {
    if (!selectedId) return
    setMessage(null)
    // Every field mandatory on the real rows; topic validated against concept tags.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const where = `"${subjName(r.subject_id)}" · ${r.chapter || 'chapter?'} (row ${i + 1})`
      if (!r.subject_id) return setMessage({ type: 'error', text: `${where}: subject missing.` })
      if (!r.faculty_id) return setMessage({ type: 'error', text: `${where}: assign a faculty.` })
      if (!r.chapter.trim()) return setMessage({ type: 'error', text: `${where}: chapter missing.` })
      if (!r.topic_name.trim()) return setMessage({ type: 'error', text: `${where}: topic is required.` })
      if (!r.planned_date) return setMessage({ type: 'error', text: `${where}: date required.` })
    }
    // ---- LIVE (per-batch) save — write straight to batch_planners, per row.
    // No delete-all + rebuild: we UPDATE each row by id, INSERT added rows, and
    // DELETE removed ones. This preserves faculty-approved reschedules and can
    // never scramble the plan the way a full rebuild could.
    if (liveLinkId) {
      const timedRows = rows.filter((r) => r.faculty_id && liveSlotByDateRef.current.get(r.planned_date)?.start_time)
      if (timedRows.length) {
        const facultyIds = Array.from(new Set(timedRows.map((r) => r.faculty_id)))
        const dates = Array.from(new Set(timedRows.map((r) => r.planned_date)))
        const { data: busyRows, error: busyErr } = await supabase
          .from('batch_planners')
          .select('id, faculty_id, planned_date, start_time, duration_minutes, subject_id, subjects(name)')
          .in('faculty_id', facultyIds)
          .in('planned_date', dates)
          .not('start_time', 'is', null)
        if (busyErr) { setMessage({ type: 'error', text: `Could not verify faculty availability: ${busyErr.message}` }); return }
        const ownIds = new Set(rows.map((r) => r.db_id).filter(Boolean))
        for (const r of timedRows) {
          const slot = liveSlotByDateRef.current.get(r.planned_date)!
          const s = toMinutes(slot.start_time!.slice(0, 5))
          const e = s + slot.duration
          for (const b of (busyRows ?? []) as { id: string; faculty_id: string; planned_date: string; start_time: string; duration_minutes: number; subject_id: string | null; subjects: { name: string } | { name: string }[] | null }[]) {
            if (ownIds.has(b.id) || b.faculty_id !== r.faculty_id || b.planned_date !== r.planned_date) continue
            const bs = toMinutes(b.start_time.slice(0, 5))
            const be = bs + b.duration_minutes
            if (s < be && e > bs) {
              const subjName2 = Array.isArray(b.subjects) ? b.subjects[0]?.name : b.subjects?.name
              setMessage({ type: 'error', text: `Save blocked: ${facName(r.faculty_id)} already has ${subjName2 ?? 'a class'} in another batch at an overlapping time on ${fmtDate(r.planned_date)}.` })
              return
            }
          }
        }
      }
      setSaving(true)
      const slotByDate = liveSlotByDateRef.current
      const batchId = filterBatch // live mode is only entered when this === link.batch_id
      const keptIds = new Set<string>()
      let updated = 0, inserted = 0
      for (const r of rows) {
        const slot = slotByDate.get(r.planned_date)
        const patch: Record<string, unknown> = {
          subject_id: r.subject_id || null, faculty_id: r.faculty_id, chapter: r.chapter.trim(), topic_name: r.topic_name.trim(),
          planned_date: r.planned_date, duration_minutes: slot?.duration ?? r.duration_minutes ?? 60,
          start_time: slot?.start_time ?? null, classroom_id: slot?.classroom_id ?? null,
        }
        if (liveHasStatus) patch.status = r.status
        if (r.db_id) {
          keptIds.add(r.db_id)
          const { error } = await supabase.from('batch_planners').update(patch).eq('id', r.db_id)
          if (error) { setSaving(false); setMessage({ type: 'error', text: `Save failed: ${error.message}` }); return }
          updated++
        } else {
          const { error } = await supabase.from('batch_planners').insert({ ...patch, batch_id: batchId, link_id: liveLinkId, is_buffer: false, stage: liveStage || 'Draft' })
          if (error) { setSaving(false); setMessage({ type: 'error', text: `Add failed: ${error.message}` }); return }
          inserted++
        }
      }
      // Rows the user removed → delete only those (buffers were never loaded).
      const toDelete = [...liveOrigIdsRef.current].filter((id) => !keptIds.has(id))
      let deleted = 0
      if (toDelete.length) { const { error } = await supabase.from('batch_planners').delete().in('id', toDelete); if (!error) deleted = toDelete.length }
      setSaving(false)
      setMessage({ type: 'success', text: `Batch schedule saved — ${updated} updated${inserted ? `, ${inserted} added` : ''}${deleted ? `, ${deleted} removed` : ''}. This is the live plan for ${liveBatchLabel}.` })
      await loadLiveRows(liveLinkId)
      return
    }

    // ---- TEMPLATE save — the shared blueprint (planner_lectures) + rebuild
    // of Draft/Rework links.
    if (rows.length === 0 && keptBuffers.length === 0) return setMessage({ type: 'error', text: 'A planner needs at least one lecture.' })

    // Order everything by date, then persist with fresh sequence numbers.
    const realClean: Keep[] = rows.map((r) => ({ subject_id: r.subject_id || null, faculty_id: r.faculty_id, chapter: r.chapter.trim(), topic_name: r.topic_name.trim(), planned_date: r.planned_date, start_time: null, duration_minutes: r.duration_minutes || 60, is_buffer: false, status: r.status }))
    const all = [...realClean, ...keptBuffers].sort((a, b) => a.planned_date.localeCompare(b.planned_date))

    setSaving(true)
    await supabase.from('planner_lectures').delete().eq('planner_id', selectedId)
    const { error } = await supabase.from('planner_lectures').insert(all.map((c, i) => ({ ...c, planner_id: selectedId, sequence_no: i })))
    if (error) { setSaving(false); setMessage({ type: 'error', text: error.message }); return }

    const editable = links.filter((l) => l.stage === 'Draft' || l.stage === 'Rework')
    const skipped = links.filter((l) => l.stage === 'Faculty Assigned' || l.stage === 'Confirmed')
    const remErrors: string[] = []
    for (const l of editable) {
      const res = await rematerialiseLink(supabase, l.id)
      if (res.errors.length) remErrors.push(`${batchName(l.batches)}: ${res.errors.slice(0, 1).join('')}`)
    }
    setSaving(false)

    let msg = `Planner saved (${realClean.length} lecture(s)).`
    if (editable.length) msg += ` Re-built ${editable.length} draft link(s).`
    if (skipped.length) msg += ` ${skipped.length} sent/confirmed link(s) left unchanged (recall to re-edit).`
    if (remErrors.length) msg += ` Warnings: ${remErrors.slice(0, 2).join('; ')}`
    setMessage({ type: remErrors.length ? 'info' : 'success', text: msg })
    await selectPlanner(selectedId)
  }

  const statusPill = (s: Status) =>
    s === 'conducted' ? 'bg-neutral-200 text-neutral-700 border-neutral-300'
      : s === 'confirmed' ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
        : 'bg-white text-neutral-500 border-neutral-200'
  const rowTint = (s: Status) => (s === 'confirmed' ? 'bg-emerald-50/60 border-emerald-200' : s === 'conducted' ? 'bg-neutral-100/70 border-neutral-200' : 'bg-white border-neutral-200')

  return (
    <div className="space-y-5">
      <datalist id="ep-topics">{topicOptions.map((t) => <option key={t} value={t} />)}</datalist>
      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      <Card className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={filterCentre} onChange={(e) => { setFilterCentre(e.target.value); setFilterBatch(''); if (selectedId) selectPlanner('') }} className="w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">All centres</option>
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
            <select value={filterBatch} onChange={(e) => { setFilterBatch(e.target.value); if (selectedId) selectPlanner('') }} className="w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">{filterCentre ? 'All batches at this centre' : 'All batches'}</option>
              {batchesForCentre.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner to edit</label>
            <select value={selectedId} onChange={(e) => selectPlanner(e.target.value)} className="w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">{loading ? 'Loading…' : plannersShown.length ? 'Choose a planner' : 'No planner for this filter'}</option>
              {plannersShown.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-neutral-400 mt-3">Filter by centre &amp; batch to find that batch&rsquo;s planner. Chapters are locked (concept tags); edit the <b>topic</b>{!liveLinkId && <>, mark each class <b>Confirmed</b> or <b>Already conducted</b> (with its final date)</>}, and drag to reorder. Dates always stay in order. {liveLinkId ? 'You are editing this batch’s LIVE schedule.' : 'Pick a Batch too to edit that batch’s live schedule; without a batch you edit the shared template (re-builds Draft/Rework links).'}</p>
      </Card>

      {selected && liveLinkId && (
        <Alert type="info">
          <b>Live batch schedule — {liveBatchLabel}.</b> This is the actual materialised plan for this batch and <b>includes every faculty-approved reschedule, prepone and cancellation</b>. Edits (topic, faculty, order) save straight to this batch only — the shared template and other batches are untouched.
        </Alert>
      )}

      {selected && subjectTabs.length > 0 && (
        <>
          {/* Subject tabs */}
          <div className="flex flex-wrap gap-2">
            {subjectTabs.map((t) => (
              <button key={t.id} onClick={() => setActiveSubject(t.id)} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeSubject === t.id ? 'bg-violet-600 text-white' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'}`}>{t.name}</button>
            ))}
          </div>

          {/* Summary for the active subject */}
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div><div className="text-xs text-neutral-400 uppercase tracking-wider">After today</div><div className="text-lg font-bold text-neutral-950">{summary.lecturesLeft} lecture{summary.lecturesLeft === 1 ? '' : 's'} left</div></div>
              <div><div className="text-xs text-neutral-400 uppercase tracking-wider">Hours left</div><div className="text-lg font-bold text-violet-700">{summary.hoursLeft.toFixed(summary.hoursLeft % 1 === 0 ? 0 : 1)} hrs</div></div>
              <div><div className="text-xs text-neutral-400 uppercase tracking-wider">Conducted</div><div className="text-lg font-bold text-neutral-500">{summary.conducted}</div></div>
              <div className="ml-auto text-xs text-neutral-400">for <b className="text-neutral-600">{subjName(activeSubject)}</b></div>
            </div>
          </Card>

          {/* Toolbar: search + reorder mode */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Search (teacher / topic / chapter)</label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. a teacher's name…" className="w-full h-10 px-3 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Drag to reorder</label>
              <div className="inline-flex rounded-lg border border-neutral-200 overflow-hidden">
                <button onClick={() => setReorderMode('rows')} className={`px-3 h-10 text-sm font-semibold ${reorderMode === 'rows' ? 'bg-violet-600 text-white' : 'bg-white text-neutral-600'}`}>Rows</button>
                <button onClick={() => setReorderMode('chapters')} className={`px-3 h-10 text-sm font-semibold ${reorderMode === 'chapters' ? 'bg-violet-600 text-white' : 'bg-white text-neutral-600'}`}>Chapters</button>
              </div>
            </div>
          </div>

          {/* Chapter groups */}
          <div className="space-y-4">
            {chapterGroups.length === 0 ? (
              <Card className="p-8 text-center text-sm text-neutral-400">No classes match.</Card>
            ) : chapterGroups.map((g) => (
              <div
                key={g.chapter}
                draggable={reorderMode === 'chapters'}
                onDragStart={() => { if (reorderMode === 'chapters') dragChapterRef.current = g.chapter }}
                onDragOver={(e) => { if (reorderMode === 'chapters') e.preventDefault() }}
                onDrop={() => reorderMode === 'chapters' && onChapterDrop(g.chapter)}
                className={`border border-neutral-200 rounded-xl overflow-hidden ${reorderMode === 'chapters' ? 'cursor-grab' : ''}`}
              >
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-neutral-50 border-b border-neutral-200">
                  <div className="flex items-center gap-2">
                    {reorderMode === 'chapters' && <span className="text-neutral-300 text-lg leading-none">⠿</span>}
                    <span className="font-bold text-neutral-950">{g.chapter}</span>
                    <span className="text-xs text-neutral-400">{g.rows.length} topic{g.rows.length === 1 ? '' : 's'} · locked</span>
                  </div>
                  <button onClick={() => addRowToChapter(activeSubject, g.chapter)} className="text-xs font-semibold text-violet-600 hover:text-violet-700 whitespace-nowrap">+ add row</button>
                </div>
                <div className="divide-y divide-neutral-100">
                  {g.rows.map((r) => (
                    <div
                      key={r.key}
                      draggable={reorderMode === 'rows' && r.status !== 'conducted'}
                      onDragStart={() => { if (reorderMode === 'rows') dragKeyRef.current = r.key }}
                      onDragOver={(e) => { if (reorderMode === 'rows') e.preventDefault() }}
                      onDrop={() => reorderMode === 'rows' && onRowDrop(r.key)}
                      className={`flex flex-wrap md:flex-nowrap items-center gap-2 px-3 py-2.5 border-l-4 ${rowTint(r.status)} ${reorderMode === 'rows' && r.status !== 'conducted' ? 'cursor-grab' : ''}`}
                    >
                      {reorderMode === 'rows' && <span className="text-neutral-300 text-lg leading-none w-4 shrink-0">{r.status !== 'conducted' ? '⠿' : ''}</span>}
                      <input
                        type="date"
                        value={r.planned_date}
                        disabled={r.status === 'conducted'}
                        onChange={(e) => {
                          const newDate = e.target.value
                          if (!newDate) return
                          const check = resolveLiveSlot(r.subject_id, r.faculty_id, newDate, r.key)
                          if (!check.ok) { setMessage({ type: 'error', text: check.error ?? 'That date conflicts with an existing class.' }); return }
                          updateRow(r.key, { planned_date: newDate })
                        }}
                        title={r.planned_date < todayISO && r.status !== 'conducted' ? 'This date is in the past' : ''}
                        className={`w-[130px] shrink-0 h-9 px-2 border rounded-lg text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500 ${r.planned_date < todayISO && r.status !== 'conducted' ? 'border-rose-200 text-rose-600 bg-rose-50/40' : 'border-neutral-200 text-neutral-600 bg-white/70'}`}
                      />
                      <input list="ep-topics" value={r.topic_name} onChange={(e) => updateRow(r.key, { topic_name: e.target.value })} placeholder="Topic taught" className="flex-1 min-w-[160px] h-9 px-2 bg-white/70 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
                      <select value={r.faculty_id} onChange={(e) => updateRow(r.key, { faculty_id: e.target.value })} className="w-[160px] shrink-0 h-9 px-2 bg-white/70 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                        <option value="">Faculty…</option>
                        {faculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                      </select>
                      {(!liveLinkId || liveHasStatus) ? (
                        <select value={r.status} onChange={(e) => setStatus(r.key, e.target.value as Status)} className={`w-[150px] shrink-0 h-9 px-2 rounded-lg text-xs font-semibold border ${statusPill(r.status)}`}>
                          <option value="planned">Planned</option>
                          <option value="confirmed">Confirmed ✓</option>
                          <option value="conducted">Already conducted</option>
                        </select>
                      ) : (
                        <span className="w-[150px] shrink-0 text-[11px] font-medium text-neutral-500 truncate" title="Faculty confirmation stage (live)">{r.stage || 'Draft'}</span>
                      )}
                      <button onClick={() => removeRow(r.key)} title="Remove" className="shrink-0 text-neutral-300 hover:text-red-600 text-lg leading-none">×</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <BtnPrimary onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : liveLinkId ? `Save live schedule (${liveBatchLabel})` : 'Save Planner (template)'}</BtnPrimary>
        </>
      )}

      {/* Already-conducted date dialog */}
      {conductKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => setConductKey(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl border border-neutral-200" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-neutral-950 mb-1">Mark already conducted</h3>
            <p className="text-sm text-neutral-500 mb-4">On which date was this topic actually taught? It will be logged as conducted and sorted into the timeline by this date.</p>
            <input type="date" value={conductDate} max={todayISO} onChange={(e) => setConductDate(e.target.value)} className="w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 mb-4" />
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={applyConducted} disabled={!conductDate}>Mark conducted</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setConductKey(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}

      {confirmKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => setConfirmKey(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl border border-neutral-200" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-neutral-950 mb-1">Confirm this class</h3>
            <p className="text-sm text-neutral-500 mb-4">Keep the current date, or move it to a new one — either way it'll be marked Confirmed.</p>
            <input type="date" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} className="w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 mb-4" />
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={applyConfirmed} disabled={!confirmDate}>Confirm</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setConfirmKey(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
