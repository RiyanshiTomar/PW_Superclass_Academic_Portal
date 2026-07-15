'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { createPlanner, assignPlanner, type PlannerLectureInput } from '@/lib/planners'
import { fetchMaster, type Master } from '@/lib/syllabus'
import { parseCSVWithHeaders, DAYS } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card } from '@/components/PortalShell'

type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type Batch = { id: string; name: string; centre_id: string; program_id: string; start_date: string; end_date: string; status: string }
type PlannerRow = { id: string; name: string; program_id: string | null; created_at: string; planner_lectures: { count: number }[] }
type ScheduleSlot = { subject_id: string | null; day_of_week: number; faculty_id: string | null }
// One planned lecture. Subject/Date/Faculty are pre-filled from the batch's
// weekly schedule; Central fills Chapter + Topic (faculty editable).
type Draft = { subject_id: string; faculty_id: string; planned_date: string; day: number; chapter: string; topic_name: string }

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()
const csvCell = (v: string) => (/[",\n]/.test(v ?? '') ? `"${(v ?? '').replace(/"/g, '""')}"` : (v ?? ''))

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad2 = (n: number) => String(n).padStart(2, '0')
function normalizeDate(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  let m = s.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/)
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/)
  if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad2(mo + 1)}-${pad2(+m[1])}` } }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (m) { const a = +m[1], b = +m[2]; let y = +m[3]; if (y < 100) y += 2000; const day = a <= 12 && b > 12 ? b : a; const mo = a <= 12 && b > 12 ? a : b; if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) return `${y}-${pad2(mo)}-${pad2(day)}` }
  return s
}

// Every date between start & end (inclusive) that falls on weekday `dow`.
function datesForDay(start: string, end: string, dow: number): string[] {
  const out: string[] = []
  const d = new Date(start + 'T12:00:00')
  const e = new Date(end + 'T12:00:00')
  while (d <= e) {
    if (d.getDay() === dow) out.push(d.toISOString().split('T')[0])
    d.setDate(d.getDate() + 1)
  }
  return out
}

export default function CreatePlanner() {
  const supabase = createClient()
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [planners, setPlanners] = useState<PlannerRow[]>([])
  const [loading, setLoading] = useState(true)

  const [centreId, setCentreId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [reviewing, setReviewing] = useState(false)
  const [draft, setDraft] = useState<Draft[]>([])
  const [master, setMaster] = useState<Master | null>(null)

  const batch = useMemo(() => batches.find((b) => b.id === batchId) ?? null, [batches, batchId])
  // Batches at the chosen centre (names can repeat across centres, so filter first).
  const centreBatches = useMemo(() => (centreId ? batches.filter((b) => b.centre_id === centreId) : []), [batches, centreId])
  const programSubjects = useMemo(() => (batch ? subjects.filter((s) => s.program_id === batch.program_id) : []), [subjects, batch])
  const subjName = (id: string) => subjects.find((s) => s.id === id)?.name ?? '—'
  const facEmail = (id: string) => faculty.find((f) => f.id === id)?.email ?? ''
  const chapterOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.map((c) => c.name)))) : []), [master])
  const topicOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.flatMap((c) => c.topics)))) : []), [master])

  // subjectId -> (chapterName -> set of its topic names), all normalised.
  const masterMap = useMemo(() => {
    const m = new Map<string, Map<string, Set<string>>>()
    for (const s of master?.subjects ?? []) {
      const cm = new Map<string, Set<string>>()
      for (const c of s.chapters) cm.set(norm(c.name), new Set(c.topics.map((t) => norm(t))))
      m.set(s.id, cm)
    }
    return m
  }, [master])

  const loadData = async () => {
    setLoading(true)
    const [batchRes, centreRes, subjRes, facRes, planRes] = await Promise.all([
      supabase.from('batches').select('id, name, centre_id, program_id, start_date, end_date, status').neq('status', 'Merged').order('created_at', { ascending: false }),
      supabase.from('centres').select('id, name').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
      supabase.rpc('list_active_faculty', { p_centre_id: null }),
      supabase.from('planners').select('id, name, program_id, created_at, planner_lectures(count)').order('created_at', { ascending: false }),
    ])
    if (batchRes.data) setBatches(batchRes.data as Batch[])
    if (centreRes.data) setCentres(centreRes.data as { id: string; name: string }[])
    if (subjRes.data) setSubjects(subjRes.data as Subject[])
    if (facRes.data) setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
    if (planRes.data) setPlanners(planRes.data as unknown as PlannerRow[])
    setLoading(false)
  }
  useEffect(() => { loadData() }, [])

  // Pick a batch → build one row per (subject, class-date) from its weekly
  // schedule, across the batch's start→end dates. Chapter/Topic start empty.
  const selectBatch = async (id: string) => {
    setBatchId(id); setMessage(null); setDraft([]); setReviewing(false); setMaster(null)
    if (!id) { setName(''); return }
    const b = batches.find((x) => x.id === id)
    if (!b) return
    setName(`${b.name} — Planner`)
    setBusy(true)
    const [schedRes, m] = await Promise.all([
      supabase.from('batch_schedules').select('subject_id, day_of_week, faculty_id').eq('batch_id', id),
      fetchMaster(supabase, b.program_id),
    ])
    setMaster(m)
    const slots = (schedRes.data ?? []) as ScheduleSlot[]
    const seen = new Set<string>()
    const rows: Draft[] = []
    for (const s of slots) {
      if (!s.subject_id) continue
      for (const dt of datesForDay(b.start_date, b.end_date, s.day_of_week)) {
        const key = `${s.subject_id}|${dt}`
        if (seen.has(key)) continue // one lecture per subject per day
        seen.add(key)
        rows.push({ subject_id: s.subject_id, faculty_id: s.faculty_id ?? '', planned_date: dt, day: s.day_of_week, chapter: '', topic_name: '' })
      }
    }
    rows.sort((a, b2) => a.planned_date.localeCompare(b2.planned_date) || subjName(a.subject_id).localeCompare(subjName(b2.subject_id)))
    setBusy(false)
    if (rows.length === 0) { setMessage({ type: 'error', text: 'This batch has no weekly schedule yet — build it in Batch Scheduler first.' }); return }
    setDraft(rows); setReviewing(true)
    setMessage({ type: 'info', text: `${rows.length} class-dates generated from the weekly schedule. Fill Chapter & Topic inline, or download the CSV, fill it, and upload. Save unlocks when every row is clean.` })
  }

  const rowError = (r: Draft): string => {
    if (!r.faculty_id) return 'Faculty missing (pick one)'
    if (!r.chapter.trim()) return 'Chapter is empty'
    const cm = masterMap.get(r.subject_id)
    if (cm && cm.size > 0) {
      const topics = cm.get(norm(r.chapter))
      if (!topics) return `Chapter "${r.chapter}" is not in this subject’s concept tags`
      if (!r.topic_name.trim()) return 'Topic is empty'
      if (topics.size > 0 && !topics.has(norm(r.topic_name))) return `Topic "${r.topic_name}" is not under this chapter in concept tags`
      return ''
    }
    if (!r.topic_name.trim()) return 'Topic is empty'
    return ''
  }
  const invalidCount = useMemo(() => draft.filter((r) => rowError(r) !== '').length, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateDraft = (i: number, patch: Partial<Draft>) => setDraft((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const downloadTemplate = () => {
    const header = ['Subject', 'Date', 'Day', 'Faculty Email', 'Chapter', 'Topic']
    const lines = [header.join(',')]
    for (const r of draft) lines.push([subjName(r.subject_id), r.planned_date, DAYS[r.day], facEmail(r.faculty_id), r.chapter, r.topic_name].map(csvCell).join(','))
    downloadCsv(lines.join('\n'), `${name.trim() || 'planner'}-template.csv`)
  }

  const downloadErrorReport = () => {
    const header = ['Subject', 'Date', 'Day', 'Faculty Email', 'Chapter', 'Topic', 'Error']
    const lines = [header.join(',')]
    for (const r of draft) {
      const err = rowError(r)
      if (!err) continue
      lines.push([subjName(r.subject_id), r.planned_date, DAYS[r.day], facEmail(r.faculty_id), r.chapter, r.topic_name, err].map(csvCell).join(','))
    }
    downloadCsv(lines.join('\n'), `${name.trim() || 'planner'}-errors.csv`)
  }

  function downloadCsv(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  // Upload the filled CSV → match each row to a generated (subject + date) slot
  // and fill its Chapter / Topic / Faculty. Dates are fixed by the schedule.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMessage(null)
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      const col = (...keys: string[]) => headers.findIndex((h) => keys.some((k) => h.includes(k)))
      const iSub = col('subject'), iDate = col('date'), iChap = col('chapter'), iTopic = col('topic'), iFac = col('faculty', 'email', 'teacher')
      if (iSub < 0 || iDate < 0 || iChap < 0 || iTopic < 0) { setMessage({ type: 'error', text: 'CSV needs Subject, Date, Chapter, Topic columns.' }); return }
      const subByName = new Map(programSubjects.map((s) => [norm(s.name), s.id]))
      const facByEmail = new Map(faculty.map((f) => [f.email.toLowerCase(), f.id]))
      const facByName = new Map(faculty.map((f) => [norm(f.full_name), f.id]))
      const idx = new Map<string, number>()
      draft.forEach((r, i) => idx.set(`${r.subject_id}|${r.planned_date}`, i))
      const next = [...draft]
      let filled = 0, unmatched = 0
      for (const row of rows) {
        const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
        const sid = subByName.get(norm(get(iSub)))
        const date = normalizeDate(get(iDate))
        if (!sid || !date) { unmatched++; continue }
        const at = idx.get(`${sid}|${date}`)
        if (at == null) { unmatched++; continue }
        const facRaw = get(iFac)
        const fid = facRaw ? (facByEmail.get(facRaw.toLowerCase()) ?? facByName.get(norm(facRaw)) ?? next[at].faculty_id) : next[at].faculty_id
        next[at] = { ...next[at], chapter: get(iChap), topic_name: get(iTopic), faculty_id: fid }
        filled++
      }
      setDraft(next)
      setMessage({ type: unmatched ? 'info' : 'success', text: `${filled} row(s) filled from CSV${unmatched ? ` · ${unmatched} row(s) didn’t match a scheduled class-date (ignored)` : ''}.` })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const cancelReview = () => { setReviewing(false); setDraft([]); setBatchId(''); setName(''); setMessage(null) }

  const savePlanner = async () => {
    if (!batch) return setMessage({ type: 'error', text: 'Select a batch.' })
    if (!name.trim()) return setMessage({ type: 'error', text: 'Give the planner a name.' })
    if (draft.length === 0) return setMessage({ type: 'error', text: 'Nothing to save.' })
    if (invalidCount > 0) return setMessage({ type: 'error', text: `${invalidCount} row(s) still have errors — fix them (or download the report) before saving.` })

    const clean: PlannerLectureInput[] = draft.map((r) => ({
      subject_id: r.subject_id,
      faculty_id: r.faculty_id,
      chapter: r.chapter.trim(),
      topic_name: r.topic_name.trim(),
      planned_date: r.planned_date,
      start_time: null,
      duration_minutes: 60,
    }))

    setBusy(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    const res = await createPlanner(supabase, { name: name.trim(), program_id: batch.program_id, description: description.trim(), created_by: appUser?.id ?? null }, clean)
    if ('error' in res) { setBusy(false); return setMessage({ type: 'error', text: res.error }) }
    // Auto-assign to the batch it was built for (materialise takes time & room
    // from the weekly schedule slot each date lands on).
    const assign = await assignPlanner(supabase, { plannerId: res.plannerId, batch: { id: batch.id, centre_id: batch.centre_id, start_date: batch.start_date, end_date: batch.end_date } })
    setBusy(false)
    if (!assign.ok) { setMessage({ type: 'error', text: `Planner saved but couldn’t assign: ${assign.errors.join(' · ')}` }); await loadData(); return }
    setMessage({ type: assign.errors.length ? 'info' : 'success', text: `Planner created & assigned to ${batch.name} — ${assign.imported} lecture(s) scheduled${assign.errors.length ? `, ${assign.errors.length} skipped` : ''}. Send it to faculty under "Assign".` })
    cancelReview()
    await loadData()
  }

  const deletePlanner = async (id: string, pname: string) => {
    if (!confirm(`Delete planner "${pname}"?\n\nThis removes the planner, all its lectures, and unlinks it from every batch — including lectures already on faculty calendars. This cannot be undone.`)) return
    setDeletingId(id); setMessage(null)
    const { error } = await supabase.from('planners').delete().eq('id', id)
    setDeletingId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    setMessage({ type: 'success', text: `Planner "${pname}" deleted.` })
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const cell = 'w-full h-9 px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="space-y-6">
      <datalist id="cp-chapters">{chapterOptions.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="cp-topics">{topicOptions.map((t) => <option key={t} value={t} />)}</datalist>

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {!reviewing ? (
        <Card className="p-6">
          <h3 className="font-bold text-neutral-950 mb-1">Create a Planner</h3>
          <p className="text-sm text-neutral-500 mb-5">Pick a centre, then a batch — its class-dates are generated from the weekly schedule (only the days each subject actually runs). Then just fill Chapter &amp; Topic; time, room &amp; faculty come from the schedule.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre *</label>
              <select value={centreId} onChange={(e) => { setCentreId(e.target.value); setBatchId(''); setReviewing(false); setDraft([]); setMaster(null); setName(''); setMessage(null) }} className={inputClass} disabled={busy || loading}>
                <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
                {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch *</label>
              <select value={batchId} onChange={(e) => selectBatch(e.target.value)} className={inputClass} disabled={busy || !centreId}>
                <option value="">{!centreId ? 'Select a centre first' : busy ? 'Loading…' : centreBatches.length ? 'Select a batch' : 'No batches at this centre'}</option>
                {centreBatches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto from batch" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional note" className={inputClass} />
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="font-bold text-neutral-950">Fill the planner — {batch?.name}</h3>
              <p className="text-sm text-neutral-500">{draft.length} class-dates from the weekly schedule. Red rows need fixing (problem shown at the end). Chapter &amp; Topic must match the concept tags.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <BtnSecondary onClick={downloadTemplate}>Download CSV</BtnSecondary>
              <label className={`inline-flex items-center px-4 h-10 rounded-xl text-sm font-semibold cursor-pointer ${busy ? 'bg-neutral-300 text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'}`}>
                Upload filled CSV
                <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleUpload} disabled={busy} />
              </label>
              {invalidCount > 0 && <BtnSecondary onClick={downloadErrorReport}>Error report ({invalidCount})</BtnSecondary>}
            </div>
          </div>
          <div className="overflow-x-auto border border-neutral-200 rounded-xl mb-4 max-h-[60vh]">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-neutral-100 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Day</th>
                  <th className="text-left px-3 py-2 min-w-[130px]">Subject</th>
                  <th className="text-left px-3 py-2 min-w-[150px]">Faculty</th>
                  <th className="text-left px-3 py-2">Chapter *</th>
                  <th className="text-left px-3 py-2 min-w-[150px]">Topic *</th>
                  <th className="text-left px-3 py-2 min-w-[170px]">Problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {draft.map((r, i) => {
                  const err = rowError(r)
                  return (
                    <tr key={i} className={err ? 'bg-rose-50/50' : ''}>
                      <td className="px-3 py-2 whitespace-nowrap text-neutral-700">{new Date(r.planned_date + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
                      <td className="px-3 py-2 text-neutral-500">{DAYS[r.day]}</td>
                      <td className="px-3 py-2 text-neutral-700">{subjName(r.subject_id)}</td>
                      <td className="px-3 py-2">
                        <select value={r.faculty_id} onChange={(e) => updateDraft(i, { faculty_id: e.target.value })} className={cell}>
                          <option value="">Select</option>
                          {faculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input list="cp-chapters" value={r.chapter} onChange={(e) => updateDraft(i, { chapter: e.target.value })} className={cell} placeholder="Chapter" /></td>
                      <td className="px-3 py-2"><input list="cp-topics" value={r.topic_name} onChange={(e) => updateDraft(i, { topic_name: e.target.value })} className={cell} placeholder="Topic" /></td>
                      <td className="px-3 py-2 text-xs text-rose-600">{err}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <BtnPrimary onClick={savePlanner} disabled={busy || invalidCount > 0}>{busy ? 'Saving…' : invalidCount > 0 ? `Fix ${invalidCount} row(s) to save` : 'Save & Assign Planner'}</BtnPrimary>
            <BtnSecondary onClick={cancelReview}>Cancel</BtnSecondary>
          </div>
        </Card>
      )}

      <Card className="p-6">
        <h4 className="font-semibold text-neutral-950 mb-3">Existing Planners</h4>
        {loading ? (
          <p className="text-neutral-400 text-sm">Loading…</p>
        ) : planners.length === 0 ? (
          <p className="text-neutral-400 text-sm">No planners yet.</p>
        ) : (
          <div className="grid gap-2">
            {planners.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 p-3 bg-neutral-50 border border-neutral-200 rounded-xl">
                <div className="min-w-0">
                  <div className="font-semibold text-neutral-950 text-sm truncate">{p.name}</div>
                  <div className="text-xs text-neutral-500">{p.planner_lectures?.[0]?.count ?? 0} lectures</div>
                </div>
                <button onClick={() => deletePlanner(p.id, p.name)} disabled={deletingId === p.id} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700 border border-red-200 rounded-lg text-xs font-semibold shrink-0">{deletingId === p.id ? 'Deleting…' : 'Delete'}</button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
