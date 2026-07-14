'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { createPlanner, type PlannerLectureInput } from '@/lib/planners'
import { fetchMaster, coverageReport, type Master } from '@/lib/syllabus'
import { parseCSVWithHeaders, toMinutes } from '@/lib/utils'
import { parsePlannedDate, parseDuration, validateOptionalTime } from '@/lib/validation'
import { Alert, BtnPrimary, BtnSecondary, Card } from '@/components/PortalShell'

type Program = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type PlannerRow = { id: string; name: string; program_id: string | null; created_at: string; planner_lectures: { count: number }[] }
// Editable draft row (all strings; fixed & validated before saving).
type Draft = { subject_id: string; faculty_id: string; chapter: string; topic_name: string; planned_date: string; start_time: string; duration_minutes: string }

export default function CreatePlanner() {
  const supabase = createClient()
  const [programs, setPrograms] = useState<Program[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [planners, setPlanners] = useState<PlannerRow[]>([])
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState('')
  const [programId, setProgramId] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Review/edit stage
  const [reviewing, setReviewing] = useState(false)
  const [draft, setDraft] = useState<Draft[]>([])
  const [master, setMaster] = useState<Master | null>(null)

  const loadData = async () => {
    setLoading(true)
    const [progRes, subjRes, facRes, planRes] = await Promise.all([
      supabase.from('programs').select('id, name').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
      supabase.rpc('list_active_faculty', { p_centre_id: null }),
      supabase.from('planners').select('id, name, program_id, created_at, planner_lectures(count)').order('created_at', { ascending: false }),
    ])
    if (progRes.data) setPrograms(progRes.data as Program[])
    if (subjRes.data) setSubjects(subjRes.data as Subject[])
    if (facRes.data) setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
    if (planRes.data) setPlanners(planRes.data as unknown as PlannerRow[])
    setLoading(false)
  }
  useEffect(() => { loadData() }, [])

  // Load the syllabus master for autocomplete + coverage when a program is set.
  useEffect(() => {
    if (!programId) { setMaster(null); return }
    fetchMaster(supabase, programId).then(setMaster)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId])

  const programSubjects = useMemo(() => subjects.filter((s) => !programId || s.program_id === programId), [subjects, programId])
  const chapterOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.map((c) => c.name)))) : []), [master])
  const topicOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.flatMap((c) => c.topics)))) : []), [master])
  const coverage = useMemo(
    () => (master ? coverageReport(master, draft.map((r) => ({ subject_id: r.subject_id || null, chapter: r.chapter, topic_name: r.topic_name }))) : null),
    [master, draft]
  )

  const deletePlanner = async (id: string, pname: string) => {
    if (!confirm(`Delete planner "${pname}"?\n\nThis permanently removes the planner, all its lectures, and unlinks it from every batch it was assigned to — including lectures already on faculty calendars. This cannot be undone.`)) return
    setDeletingId(id); setMessage(null)
    const { error } = await supabase.from('planners').delete().eq('id', id)
    setDeletingId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    setMessage({ type: 'success', text: `Planner "${pname}" deleted.` })
    await loadData()
  }

  // Upload → parse EVERY row into an editable draft (nothing is rejected).
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!name.trim()) { setMessage({ type: 'error', text: 'Give the planner a name before uploading.' }); if (fileRef.current) fileRef.current.value = ''; return }
    setBusy(true); setMessage(null)
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      if (rows.length === 0) { setMessage({ type: 'error', text: 'CSV is empty or only has a header row.' }); return }
      const col = (...keys: string[]) => headers.findIndex((h) => keys.some((k) => h.includes(k)))
      const iSub = col('subject'), iChap = col('chapter'), iTopic = col('topic'), iFac = col('faculty', 'email', 'teacher'), iDate = col('date'), iEnd = col('end')
      let iTime = col('start'); if (iTime < 0) iTime = headers.findIndex((h) => h.includes('time') && !h.includes('end'))
      const iDur = col('duration', 'min')
      const missing: string[] = []
      if (iChap < 0) missing.push('Chapter'); if (iTopic < 0) missing.push('Topic'); if (iFac < 0) missing.push('Faculty Email'); if (iDate < 0) missing.push('Date')
      if (missing.length) { setMessage({ type: 'error', text: `CSV header missing column(s): ${missing.join(', ')}. Names can be in any order.` }); return }

      const pool = subjects.filter((s) => !programId || s.program_id === programId)
      const facByEmail = new Map(faculty.map((f) => [f.email.toLowerCase(), f.id]))
      const d: Draft[] = []
      let facMiss = 0
      for (const row of rows) {
        const get = (idx: number) => (idx >= 0 ? (row[idx] ?? '').trim() : '')
        const subName = get(iSub), chapter = get(iChap), topic = get(iTopic), facEmail = get(iFac), pDate = get(iDate), startRaw = get(iTime), endRaw = get(iEnd), durRaw = get(iDur)
        if (!chapter && !topic && !facEmail && !pDate) continue // fully blank
        const facultyId = facEmail ? facByEmail.get(facEmail.toLowerCase()) ?? '' : ''
        if (facEmail && !facultyId) facMiss++
        const sub = pool.find((s) => s.name.toLowerCase() === subName.toLowerCase()) ?? subjects.find((s) => s.name.toLowerCase() === subName.toLowerCase())
        let duration = '60'
        if (startRaw && endRaw) { const mins = toMinutes(endRaw) - toMinutes(startRaw); if (mins > 0) duration = String(mins) }
        else if (durRaw) duration = durRaw
        d.push({ subject_id: sub?.id ?? '', faculty_id: facultyId, chapter, topic_name: topic, planned_date: pDate, start_time: startRaw, duration_minutes: duration })
      }
      if (d.length === 0) { setMessage({ type: 'error', text: 'No data rows found.' }); return }
      setDraft(d); setReviewing(true)
      setMessage({ type: facMiss ? 'info' : 'success', text: `${d.length} lecture(s) loaded${facMiss ? ` — ${facMiss} faculty email(s) not matched (pick manually)` : ''}. Review, fix any red rows, then Save.` })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const updateDraft = (i: number, patch: Partial<Draft>) => setDraft((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addDraftRow = () => setDraft((prev) => [...prev, { subject_id: '', faculty_id: '', chapter: '', topic_name: '', planned_date: '', start_time: '', duration_minutes: '60' }])
  const removeDraftRow = (i: number) => setDraft((prev) => prev.filter((_, idx) => idx !== i))
  const rowValid = (r: Draft) => !!(r.chapter.trim() && r.topic_name.trim() && r.faculty_id && parsePlannedDate(r.planned_date) && parseDuration(r.duration_minutes || '60') && !validateOptionalTime(r.start_time))

  const cancelReview = () => { setReviewing(false); setDraft([]); setMessage(null) }

  const savePlanner = async () => {
    if (!name.trim()) return setMessage({ type: 'error', text: 'Give the planner a name.' })
    const clean: PlannerLectureInput[] = []
    for (let i = 0; i < draft.length; i++) {
      const r = draft[i]; const rn = i + 1
      if (!r.chapter.trim() || !r.topic_name.trim()) return setMessage({ type: 'error', text: `Row ${rn}: chapter & topic required.` })
      if (!r.faculty_id) return setMessage({ type: 'error', text: `Row ${rn}: pick a faculty.` })
      if (!parsePlannedDate(r.planned_date)) return setMessage({ type: 'error', text: `Row ${rn}: valid date (YYYY-MM-DD) required.` })
      const startErr = validateOptionalTime(r.start_time)
      if (startErr) return setMessage({ type: 'error', text: `Row ${rn}: start ${startErr}` })
      const dur = parseDuration(r.duration_minutes || '60')
      if (!dur) return setMessage({ type: 'error', text: `Row ${rn}: duration must be 15–480 min.` })
      clean.push({ subject_id: r.subject_id || null, faculty_id: r.faculty_id, chapter: r.chapter.trim(), topic_name: r.topic_name.trim(), planned_date: r.planned_date, start_time: r.start_time || null, duration_minutes: dur })
    }
    if (clean.length === 0) return setMessage({ type: 'error', text: 'Add at least one lecture.' })
    setBusy(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    const res = await createPlanner(supabase, { name: name.trim(), program_id: programId || null, description: description.trim(), created_by: appUser?.id ?? null }, clean)
    setBusy(false)
    if ('error' in res) return setMessage({ type: 'error', text: res.error })
    setMessage({ type: 'success', text: `Planner "${name.trim()}" created with ${clean.length} lecture(s). Assign it to a batch under "Assign".` })
    setReviewing(false); setDraft([]); setName(''); setDescription('')
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const cell = 'w-full h-9 px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="space-y-6">
      <datalist id="cp-chapters">{chapterOptions.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="cp-topics">{topicOptions.map((t) => <option key={t} value={t} />)}</datalist>

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {reviewing ? (
        <>
          {/* Coverage warning (live) */}
          {coverage && coverage.hasMaster && (
            <Card className="p-5">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-neutral-950">Syllabus coverage</h4>
                <span className={`text-sm font-bold ${coverage.chaptersCovered === coverage.chaptersTotal ? 'text-emerald-600' : 'text-amber-600'}`}>{coverage.chaptersCovered}/{coverage.chaptersTotal} chapters fully covered</span>
              </div>
              {coverage.unknown.length > 0 && (
                <div className="mb-2 text-xs bg-rose-50 border border-rose-200 rounded-lg p-2 text-rose-700"><span className="font-semibold">Not in syllabus (check spelling):</span> {coverage.unknown.slice(0, 12).join(', ')}</div>
              )}
              <div className="flex flex-wrap gap-2">
                {coverage.subjects.map((s) => (
                  <span key={s.subjectId} title={s.missing.length ? `Missing: ${s.missing.map((m) => m.chapter).join(', ')}` : 'Fully covered'} className={`text-xs px-2 py-1 rounded-lg border ${s.chaptersCovered === s.chaptersTotal ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{s.name}: {s.chaptersCovered}/{s.chaptersTotal}</span>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-neutral-950">Review & fix — {name || 'planner'}</h3>
                <p className="text-sm text-neutral-500">Red rows have something missing. Fix inline (chapter/topic suggest from syllabus), then Save.</p>
              </div>
              <BtnSecondary onClick={addDraftRow}>+ Add row</BtnSecondary>
            </div>
            <div className="overflow-x-auto border border-neutral-200 rounded-xl mb-4">
              <table className="w-full text-sm min-w-[960px]">
                <thead>
                  <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                    <th className="text-left px-3 py-2 min-w-[140px]">Subject</th>
                    <th className="text-left px-3 py-2 min-w-[160px]">Faculty *</th>
                    <th className="text-left px-3 py-2">Chapter *</th>
                    <th className="text-left px-3 py-2 min-w-[150px]">Topic *</th>
                    <th className="text-left px-3 py-2">Date *</th>
                    <th className="text-left px-3 py-2">Start</th>
                    <th className="text-left px-3 py-2">Mins</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {draft.map((r, i) => (
                    <tr key={i} className={rowValid(r) ? '' : 'bg-rose-50/50'}>
                      <td className="px-3 py-2">
                        <select value={r.subject_id} onChange={(e) => updateDraft(i, { subject_id: e.target.value })} className={cell}>
                          <option value="">—</option>
                          {programSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select value={r.faculty_id} onChange={(e) => updateDraft(i, { faculty_id: e.target.value })} className={cell}>
                          <option value="">Select faculty</option>
                          {faculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input list="cp-chapters" value={r.chapter} onChange={(e) => updateDraft(i, { chapter: e.target.value })} className={cell} placeholder="Ch 1" /></td>
                      <td className="px-3 py-2"><input list="cp-topics" value={r.topic_name} onChange={(e) => updateDraft(i, { topic_name: e.target.value })} className={cell} placeholder="Topic" /></td>
                      <td className="px-3 py-2"><input type="date" value={r.planned_date} onChange={(e) => updateDraft(i, { planned_date: e.target.value })} className={cell} /></td>
                      <td className="px-3 py-2"><input type="time" value={r.start_time} onChange={(e) => updateDraft(i, { start_time: e.target.value })} className={cell} /></td>
                      <td className="px-3 py-2"><input type="number" min={15} max={480} value={r.duration_minutes} onChange={(e) => updateDraft(i, { duration_minutes: e.target.value })} className={`${cell} w-20`} /></td>
                      <td className="px-2 py-2 text-center"><button onClick={() => removeDraftRow(i)} className="text-neutral-300 hover:text-red-600 text-lg">×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3">
              <BtnPrimary onClick={savePlanner} disabled={busy}>{busy ? 'Saving…' : 'Save Planner'}</BtnPrimary>
              <BtnSecondary onClick={cancelReview}>Cancel</BtnSecondary>
            </div>
          </Card>
        </>
      ) : (
        <>
          <Card className="p-6">
            <h3 className="font-bold text-neutral-950 mb-1">Create a Planner</h3>
            <p className="text-sm text-neutral-500 mb-5">Upload a CSV — it opens an editable preview so you can fix anything before saving. The planner is batch-agnostic.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner Name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="CA Foundation — Term 1" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Program (for coverage/suggest)</label>
                <select value={programId} onChange={(e) => setProgramId(e.target.value)} className={inputClass}>
                  <option value="">Any program</option>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Description</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional note" className={inputClass} />
              </div>
            </div>
            <label className={`inline-flex items-center px-5 h-10 rounded-xl text-sm font-semibold cursor-pointer transition-colors ${busy ? 'bg-neutral-300 text-white' : 'bg-violet-500 hover:bg-violet-600 text-white'}`}>
              {busy ? 'Processing…' : 'Upload CSV'}
              <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleUpload} disabled={busy} />
            </label>
          </Card>

          <Card className="p-6 bg-violet-50 border-violet-200">
            <h4 className="font-semibold text-violet-900 mb-2">CSV Format</h4>
            <code className="text-xs bg-white px-3 py-2 rounded border border-violet-200 block">Subject, Chapter, Topic, Faculty Email, Date, Start Time, End Time, Duration</code>
            <ul className="text-xs text-violet-700 mt-2 space-y-0.5">
              <li>• <span className="font-semibold">Required:</span> Chapter, Topic, Faculty Email, Date (YYYY-MM-DD) — but even if some are wrong, you can fix them in the preview.</li>
              <li>• <span className="font-semibold">Optional:</span> Subject, Start + End Time (HH:MM) or Duration (min).</li>
            </ul>
          </Card>
        </>
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
                  <div className="text-xs text-neutral-500">{programs.find((pr) => pr.id === p.program_id)?.name ?? 'Any program'}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs font-medium text-neutral-600">{p.planner_lectures?.[0]?.count ?? 0} lectures</span>
                  <button onClick={() => deletePlanner(p.id, p.name)} disabled={deletingId === p.id} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700 border border-red-200 rounded-lg text-xs font-semibold">{deletingId === p.id ? 'Deleting…' : 'Delete'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
