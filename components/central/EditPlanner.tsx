'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { rematerialiseLink } from '@/lib/planners'
import { fetchMaster, type Master } from '@/lib/syllabus'
import { addDaysToDate } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card } from '@/components/PortalShell'

type Planner = { id: string; name: string; program_id: string | null }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type LinkLite = { id: string; stage: string; batches: { name: string } | { name: string }[] | null }
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
}
// Buffer / empty template rows are preserved untouched (not shown in this board).
type Keep = { subject_id: string | null; faculty_id: string | null; chapter: string; topic_name: string; planned_date: string; start_time: string | null; duration_minutes: number; is_buffer: boolean; status: string }

function batchName(v: LinkLite['batches']): string {
  if (!v) return 'Batch'
  return Array.isArray(v) ? v[0]?.name ?? 'Batch' : v.name ?? 'Batch'
}
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().replace(/s$/, '')
const fmtDate = (d: string) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const daysBetweenISO = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000)

// EDIT-PLANNER ONLY: re-base each subject's upcoming (non-conducted) rows so
// they start at TODAY, preserving the gaps between them. Conducted rows keep
// their real (final) date. Central then marks what's already done with its
// conducted date and confirms the rest from today onward.
function rebaseFromToday(all: EditRow[], today: string): EditRow[] {
  const result = [...all]
  const subjectIds = Array.from(new Set(all.map((r) => r.subject_id)))
  for (const sid of subjectIds) {
    const upcoming = all.filter((r) => r.subject_id === sid && r.status !== 'conducted').sort((a, b) => a.planned_date.localeCompare(b.planned_date))
    if (upcoming.length === 0) continue
    const dateByKey = new Map<string, string>()
    let cur = today
    dateByKey.set(upcoming[0].key, cur)
    for (let i = 1; i < upcoming.length; i++) {
      const gap = Math.max(0, upcoming[i].planned_date && upcoming[i - 1].planned_date ? daysBetweenISO(upcoming[i - 1].planned_date, upcoming[i].planned_date) : 1)
      cur = addDaysToDate(cur, gap)
      dateByKey.set(upcoming[i].key, cur)
    }
    for (let j = 0; j < result.length; j++) if (dateByKey.has(result[j].key)) result[j] = { ...result[j], planned_date: dateByKey.get(result[j].key)! }
  }
  return result
}

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

  const [activeSubject, setActiveSubject] = useState('')
  const [search, setSearch] = useState('')
  const [reorderMode, setReorderMode] = useState<'rows' | 'chapters'>('rows')
  const dragKeyRef = useRef<string | null>(null)
  const dragChapterRef = useRef<string | null>(null)
  // "Already conducted" date dialog
  const [conductKey, setConductKey] = useState<string | null>(null)
  const [conductDate, setConductDate] = useState('')

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
    if (!id) { setRows([]); setKeptBuffers([]); setLinks([]); setMaster(null); setActiveSubject(''); return }
    const prog = planners.find((p) => p.id === id)?.program_id ?? null
    fetchMaster(supabase, prog ?? '').then(setMaster)
    let [lecRes, linkRes] = await Promise.all([
      supabase.from('planner_lectures').select('subject_id, faculty_id, chapter, topic_name, planned_date, duration_minutes, is_buffer, status').eq('planner_id', id).order('planned_date', { ascending: true }),
      supabase.from('batch_planner_links').select('id, stage, batches(name)').eq('planner_id', id),
    ])
    // If the status column isn't there yet (migration not run), read without it.
    if (lecRes.error) {
      lecRes = (await supabase.from('planner_lectures').select('subject_id, faculty_id, chapter, topic_name, planned_date, duration_minutes, is_buffer').eq('planner_id', id).order('planned_date', { ascending: true })) as typeof lecRes
    }
    const real: EditRow[] = []
    const buffers: Keep[] = []
    for (const l of (lecRes.data ?? []) as Record<string, unknown>[]) {
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
        // preserve buffer / empty rows exactly as they are
        buffers.push({ subject_id: (l.subject_id as string) ?? null, faculty_id: (l.faculty_id as string) ?? null, chapter, topic_name: topic, planned_date: (l.planned_date as string) ?? '', start_time: null, duration_minutes: (l.duration_minutes as number) ?? 60, is_buffer: (l.is_buffer as boolean) ?? true, status: (l.status as string) ?? 'planned' })
      }
    }
    // Edit-Planner rule: upcoming classes start from TODAY (conducted keep their date).
    setRows(rebaseFromToday(real, todayISO))
    setKeptBuffers(buffers)
    setLinks((linkRes.data ?? []) as unknown as LinkLite[])
    const firstSubj = real[0]?.subject_id ?? ''
    setActiveSubject(firstSubj)
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
  const relayer = (all: EditRow[], subjectId: string): EditRow[] => {
    const upcoming = all.filter((r) => r.subject_id === subjectId && r.status !== 'conducted')
    const slots = upcoming.map((r) => r.planned_date).filter(Boolean).sort()
    // extend the ladder if we somehow have more rows than dates (e.g. after Add)
    while (slots.length < upcoming.length) {
      const last = slots[slots.length - 1] || todayISO
      const gap = slots.length >= 2 ? Math.max(1, Math.round((new Date(slots[slots.length - 1] + 'T12:00:00').getTime() - new Date(slots[slots.length - 2] + 'T12:00:00').getTime()) / 86400000)) : 1
      slots.push(addDaysToDate(last, gap))
    }
    let i = 0
    const dateByKey = new Map<string, string>()
    for (const r of upcoming) { dateByKey.set(r.key, slots[i] ?? todayISO); i++ }
    return all.map((r) => (dateByKey.has(r.key) ? { ...r, planned_date: dateByKey.get(r.key)! } : r))
  }

  const updateRow = (key: string, patch: Partial<EditRow>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const addRowToChapter = (subjectId: string, chapter: string) => {
    setRows((prev) => {
      const sample = prev.find((r) => r.subject_id === subjectId && r.chapter === chapter)
      const upDates = prev.filter((r) => r.subject_id === subjectId && r.status !== 'conducted').map((r) => r.planned_date).filter(Boolean).sort()
      const last = upDates[upDates.length - 1] || todayISO
      const gap = upDates.length >= 2 ? Math.max(1, Math.round((new Date(upDates[upDates.length - 1] + 'T12:00:00').getTime() - new Date(upDates[upDates.length - 2] + 'T12:00:00').getTime()) / 86400000)) : 7
      const newRow: EditRow = { key: nextKey(), subject_id: subjectId, faculty_id: sample?.faculty_id ?? '', chapter, topic_name: '', planned_date: addDaysToDate(last, gap), duration_minutes: sample?.duration_minutes ?? 60, status: 'planned' }
      // insert after the chapter's last row
      let idx = -1
      prev.forEach((r, i) => { if (r.subject_id === subjectId && r.chapter === chapter) idx = i })
      const next = [...prev]
      next.splice(idx + 1, 0, newRow)
      return relayer(next, subjectId)
    })
  }

  const removeRow = (key: string) => setRows((prev) => {
    const row = prev.find((r) => r.key === key)
    const next = prev.filter((r) => r.key !== key)
    return row ? relayer(next, row.subject_id) : next
  })

  const setStatus = (key: string, status: Status) => {
    if (status === 'conducted') {
      const r = rows.find((x) => x.key === key)
      setConductKey(key); setConductDate(r?.planned_date && r.planned_date <= todayISO ? r.planned_date : todayISO)
      return
    }
    setRows((prev) => {
      const row = prev.find((r) => r.key === key)
      const next = prev.map((r) => (r.key === key ? { ...r, status } : r))
      return row ? relayer(next, row.subject_id) : next
    })
  }

  const applyConducted = () => {
    if (!conductKey || !conductDate) return
    setRows((prev) => {
      const row = prev.find((r) => r.key === conductKey)
      const next = prev.map((r) => (r.key === conductKey ? { ...r, status: 'conducted' as Status, planned_date: conductDate } : r))
      return row ? relayer(next, row.subject_id) : next
    })
    setConductKey(null); setConductDate('')
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
      const without = prev.filter((r) => r.key !== dragKey)
      const ti = without.findIndex((r) => r.key === targetKey)
      without.splice(ti, 0, drag)
      return relayer(without, drag.subject_id)
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
      const cm = masterMap.get(r.subject_id)
      if (cm && cm.size > 0) {
        const topics = cm.get(norm(r.chapter))
        if (topics && topics.size > 0 && !topics.has(norm(r.topic_name))) return setMessage({ type: 'error', text: `${where}: topic "${r.topic_name}" isn't under this chapter in the concept tags.` })
      }
    }
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
        <p className="text-xs text-neutral-400 mt-3">Filter by centre &amp; batch to find that batch&rsquo;s planner. Chapters are locked (concept tags); edit the <b>topic</b>, mark each class <b>Confirmed</b> or <b>Already conducted</b> (with its final date), and drag to reorder. Dates always stay in order. Editing re-builds only Draft/Rework links — sent/confirmed classes change via a reschedule request.</p>
      </Card>

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
                      <div className="w-[130px] shrink-0 text-xs font-semibold text-neutral-600">{fmtDate(r.planned_date)}{r.planned_date < todayISO && r.status !== 'conducted' && <span className="ml-1 text-rose-500" title="date is in the past">•</span>}</div>
                      <input list="ep-topics" value={r.topic_name} onChange={(e) => updateRow(r.key, { topic_name: e.target.value })} placeholder="Topic taught" className="flex-1 min-w-[160px] h-9 px-2 bg-white/70 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
                      <select value={r.faculty_id} onChange={(e) => updateRow(r.key, { faculty_id: e.target.value })} className="w-[160px] shrink-0 h-9 px-2 bg-white/70 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                        <option value="">Faculty…</option>
                        {faculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                      </select>
                      <select value={r.status} onChange={(e) => setStatus(r.key, e.target.value as Status)} className={`w-[150px] shrink-0 h-9 px-2 rounded-lg text-xs font-semibold border ${statusPill(r.status)}`}>
                        <option value="planned">Planned</option>
                        <option value="confirmed">Confirmed ✓</option>
                        <option value="conducted">Already conducted</option>
                      </select>
                      <button onClick={() => removeRow(r.key)} title="Remove" className="shrink-0 text-neutral-300 hover:text-red-600 text-lg leading-none">×</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <BtnPrimary onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Planner'}</BtnPrimary>
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
    </div>
  )
}
