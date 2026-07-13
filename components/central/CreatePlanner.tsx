'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { createPlanner, type PlannerLectureInput } from '@/lib/planners'
import { fetchMaster, coverageReport, type Coverage } from '@/lib/syllabus'
import { parseCSVWithHeaders, toMinutes } from '@/lib/utils'
import { parsePlannedDate, parseDuration, validateOptionalTime } from '@/lib/validation'
import { Alert, BtnPrimary, Card } from '@/components/PortalShell'

type Program = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type PlannerRow = { id: string; name: string; program_id: string | null; created_at: string; planner_lectures: { count: number }[] }

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
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const deletePlanner = async (id: string, name: string) => {
    if (!confirm(`Delete planner "${name}"?\n\nThis permanently removes the planner, all its lectures, and unlinks it from every batch it was assigned to — including lectures already on faculty calendars. This cannot be undone.`)) return
    setDeletingId(id)
    setMessage(null)
    // FKs cascade: planner_lectures, batch_planner_links, and their batch_planners rows all go.
    const { error } = await supabase.from('planners').delete().eq('id', id)
    setDeletingId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    setMessage({ type: 'success', text: `Planner "${name}" deleted.` })
    await loadData()
  }

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

  useEffect(() => {
    loadData()
  }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!name.trim()) {
      setMessage({ type: 'error', text: 'Give the planner a name before uploading.' })
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true)
    setMessage(null)
    setCoverage(null)
    try {
      const text = await file.text()
      const { headers, rows } = parseCSVWithHeaders(text)
      if (rows.length === 0) { setMessage({ type: 'error', text: 'CSV is empty or only has a header row.' }); return }

      // Match columns by header name (any order, extra columns ignored).
      const col = (...keys: string[]) => headers.findIndex((h) => keys.some((k) => h.includes(k)))
      const iSub = col('subject')
      const iChap = col('chapter')
      const iTopic = col('topic')
      const iFac = col('faculty', 'email', 'teacher')
      const iDate = col('date')
      const iEnd = col('end')
      // Start time: prefer a "start" header; else a generic "time" that isn't the end column.
      let iTime = col('start')
      if (iTime < 0) iTime = headers.findIndex((h) => h.includes('time') && !h.includes('end'))
      const iDur = col('duration', 'min')

      const missing: string[] = []
      if (iChap < 0) missing.push('Chapter')
      if (iTopic < 0) missing.push('Topic')
      if (iFac < 0) missing.push('Faculty Email')
      if (iDate < 0) missing.push('Date')
      if (missing.length) {
        setMessage({ type: 'error', text: `CSV header missing column(s): ${missing.join(', ')}. Header names can be in any order.` })
        return
      }

      const pool = subjects.filter((s) => !programId || s.program_id === programId)
      const facultyByEmail = new Map(faculty.map((f) => [f.email.toLowerCase(), f.id]))
      const lectures: PlannerLectureInput[] = []
      const errs: string[] = []

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const rn = i + 2
        const get = (idx: number) => (idx >= 0 ? (row[idx] ?? '').trim() : '')
        const subName = get(iSub)
        const chapter = get(iChap)
        const topic = get(iTopic)
        const facEmail = get(iFac)
        const pDate = get(iDate)
        const startRaw = get(iTime)
        const endRaw = get(iEnd)
        const durRaw = get(iDur)
        if (!chapter || !topic) { errs.push(`Row ${rn}: chapter & topic required`); continue }
        const facultyId = facEmail ? facultyByEmail.get(facEmail.toLowerCase()) ?? null : null
        if (facEmail && !facultyId) { errs.push(`Row ${rn}: faculty "${facEmail}" not found (must be an active faculty)`); continue }
        if (!facultyId) { errs.push(`Row ${rn}: faculty email required`); continue }
        if (!parsePlannedDate(pDate)) { errs.push(`Row ${rn}: bad date (use YYYY-MM-DD)`); continue }
        const startErr = validateOptionalTime(startRaw)
        if (startErr) { errs.push(`Row ${rn}: start ${startErr}`); continue }
        const endErr = validateOptionalTime(endRaw)
        if (endErr) { errs.push(`Row ${rn}: end ${endErr}`); continue }

        // Duration: if Start + End both given, compute (end − start); else use Duration column (default 60).
        let duration: number | null
        if (startRaw && endRaw) {
          const mins = toMinutes(endRaw) - toMinutes(startRaw)
          if (mins <= 0) { errs.push(`Row ${rn}: End Time must be after Start Time`); continue }
          duration = mins >= 15 && mins <= 480 ? mins : null
          if (!duration) { errs.push(`Row ${rn}: class length must be 15–480 min`); continue }
        } else {
          duration = parseDuration(durRaw || '60')
          if (!duration) { errs.push(`Row ${rn}: duration must be 15–480 min`); continue }
        }
        const sub = pool.find((s) => s.name.toLowerCase() === subName.toLowerCase())
          ?? subjects.find((s) => s.name.toLowerCase() === subName.toLowerCase())
        if (subName && !sub) { errs.push(`Row ${rn}: subject "${subName}" not found`); continue }
        lectures.push({
          subject_id: sub?.id ?? null,
          faculty_id: facultyId,
          chapter,
          topic_name: topic,
          planned_date: pDate,
          start_time: startRaw || null,
          duration_minutes: duration,
        })
      }

      if (lectures.length === 0) {
        setMessage({ type: 'error', text: `No valid rows. ${errs.slice(0, 4).join('; ')}` })
        return
      }

      const { data: { user } } = await supabase.auth.getUser()
      const appUser = user ? await getAppUser(supabase, user) : null

      const res = await createPlanner(
        supabase,
        { name: name.trim(), program_id: programId || null, description: description.trim(), created_by: appUser?.id ?? null },
        lectures
      )
      if ('error' in res) { setMessage({ type: 'error', text: res.error }); return }

      // Coverage vs the syllabus master (needs a program to compare against).
      if (programId) {
        const master = await fetchMaster(supabase, programId)
        setCoverage(coverageReport(master, lectures))
      }

      let msg = `Planner "${name.trim()}" created with ${lectures.length} lecture(s).`
      if (errs.length) msg += ` ${errs.length} row(s) skipped: ${errs.slice(0, 3).join('; ')}`
      setMessage({ type: 'success', text: msg + ' Assign it to a batch under "Assign".' })
      setName(''); setProgramId(''); setDescription('')
      await loadData()
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="space-y-6">
      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {coverage && (
        !coverage.hasMaster ? (
          <Card className="p-4 bg-amber-50 border-amber-200">
            <p className="text-sm text-amber-800">No syllabus master for this program yet — add subjects/chapters/topics in <span className="font-semibold">Admin → Syllabus</span> to enable coverage checks.</p>
          </Card>
        ) : (
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-neutral-950">Syllabus coverage</h4>
              <span className={`text-sm font-bold ${coverage.chaptersCovered === coverage.chaptersTotal ? 'text-emerald-600' : 'text-amber-600'}`}>
                {coverage.chaptersCovered}/{coverage.chaptersTotal} chapters fully covered
              </span>
            </div>
            {coverage.unknown.length > 0 && (
              <div className="mb-3 text-xs bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-700">
                <span className="font-semibold">Not in syllabus (check spelling):</span> {coverage.unknown.slice(0, 12).join(', ')}{coverage.unknown.length > 12 ? ` +${coverage.unknown.length - 12} more` : ''}
              </div>
            )}
            <div className="space-y-2">
              {coverage.subjects.map((s) => (
                <div key={s.subjectId} className="border border-neutral-200 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-neutral-900">{s.name}</span>
                    <span className={`text-xs font-semibold ${s.chaptersCovered === s.chaptersTotal ? 'text-emerald-600' : 'text-amber-600'}`}>{s.chaptersCovered}/{s.chaptersTotal}</span>
                  </div>
                  {s.missing.length > 0 && (
                    <ul className="mt-1 text-xs text-neutral-600 space-y-0.5">
                      {s.missing.map((m) => (
                        <li key={m.chapter}>
                          <span className="text-amber-600">⚠</span> {m.chapter}
                          {m.missingTopics.length > 0 && <span className="text-neutral-400"> — missing: {m.missingTopics.slice(0, 5).join(', ')}{m.missingTopics.length > 5 ? '…' : ''}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-neutral-400 mt-3">Tip: fix names or add the missing lectures, then re-upload (existing planner names are matched to the master).</p>
          </Card>
        )
      )}

      <Card className="p-6">
        <h3 className="font-bold text-neutral-950 mb-1">Create a Planner</h3>
        <p className="text-sm text-neutral-500 mb-5">Upload a CSV of lectures. The planner is batch-agnostic — you assign faculty and batches later.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="CA Foundation — Term 1" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Program (optional)</label>
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
        <p className="text-xs text-neutral-500 mb-4">Faculty is set <span className="font-semibold">per lecture</span> in the CSV (Faculty Email column) — a planner can span many teachers. Each teacher only sees their own lectures.</p>
        <label className={`inline-flex items-center px-5 h-10 rounded-xl text-sm font-semibold cursor-pointer transition-colors ${busy ? 'bg-neutral-300 text-white' : 'bg-violet-500 hover:bg-violet-500 text-white'}`}>
          {busy ? 'Processing…' : 'Upload CSV'}
          <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleUpload} disabled={busy} />
        </label>
      </Card>

      <Card className="p-6 bg-violet-50 border-violet-200">
        <h4 className="font-semibold text-violet-900 mb-2">CSV Format</h4>
        <p className="text-sm text-violet-800 mb-3">First row must be a header. Columns are matched <span className="font-semibold">by name</span> — so any order works, and extra columns are ignored.</p>
        <code className="text-xs bg-white px-3 py-2 rounded border border-violet-200 block">Subject, Chapter, Topic, Faculty Email, Date, Start Time, End Time, Duration</code>
        <ul className="text-xs text-violet-700 mt-2 space-y-0.5">
          <li>• <span className="font-semibold">Required:</span> Chapter, Topic, Faculty Email, Date (YYYY-MM-DD)</li>
          <li>• <span className="font-semibold">Optional:</span> Subject, Start Time &amp; End Time (HH:MM), Duration (minutes)</li>
          <li>• Give <span className="font-semibold">Start Time + End Time</span> and the class length is auto-calculated. Or give Duration directly (default 60).</li>
          <li>• Example row: Accountancy, Ch 1, Introduction, ravi.kumar@pw.live, 2026-08-01, 10:00, 11:30, </li>
        </ul>
      </Card>

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
                  <button
                    onClick={() => deletePlanner(p.id, p.name)}
                    disabled={deletingId === p.id}
                    className="px-3 py-1.5 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700 border border-red-200 rounded-lg text-xs font-semibold"
                  >
                    {deletingId === p.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
