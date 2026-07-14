'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { rematerialiseLink } from '@/lib/planners'
import { fetchMaster, coverageReport, type Master } from '@/lib/syllabus'
import { parsePlannedDate, parseDuration, validateOptionalTime } from '@/lib/validation'
import { Alert, BtnPrimary, BtnSecondary, Card } from '@/components/PortalShell'

type Planner = { id: string; name: string; program_id: string | null }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string }
type LinkLite = { id: string; stage: string; batches: { name: string } | { name: string }[] | null }
type EditRow = {
  subject_id: string
  faculty_id: string
  chapter: string
  topic_name: string
  planned_date: string
  start_time: string
  duration_minutes: string
}

function batchName(v: LinkLite['batches']): string {
  if (!v) return 'Batch'
  return Array.isArray(v) ? v[0]?.name ?? 'Batch' : v.name ?? 'Batch'
}

export default function EditPlanner() {
  const supabase = createClient()
  const [planners, setPlanners] = useState<Planner[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [rows, setRows] = useState<EditRow[]>([])
  const [links, setLinks] = useState<LinkLite[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [master, setMaster] = useState<Master | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const selected = planners.find((p) => p.id === selectedId) ?? null
  const subjectPool = useMemo(
    () => subjects.filter((s) => !selected?.program_id || s.program_id === selected.program_id),
    [subjects, selected]
  )
  const chapterOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.map((c) => c.name)))) : []), [master])
  const topicOptions = useMemo(() => (master ? Array.from(new Set(master.subjects.flatMap((s) => s.chapters.flatMap((c) => c.topics)))) : []), [master])
  const coverage = useMemo(
    () => (master ? coverageReport(master, rows.map((r) => ({ subject_id: r.subject_id || null, chapter: r.chapter, topic_name: r.topic_name }))) : null),
    [master, rows]
  )

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [planRes, subjRes, facRes] = await Promise.all([
        supabase.from('planners').select('id, name, program_id').order('created_at', { ascending: false }),
        supabase.from('subjects').select('id, name, program_id').order('name'),
        supabase.rpc('list_active_faculty', { p_centre_id: null }),
      ])
      if (planRes.data) setPlanners(planRes.data as Planner[])
      if (subjRes.data) setSubjects(subjRes.data as Subject[])
      if (facRes.data) setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
      setLoading(false)
    }
    load()
  }, [])

  const selectPlanner = async (id: string) => {
    setSelectedId(id)
    setMessage(null)
    if (!id) { setRows([]); setLinks([]); setMaster(null); return }
    const prog = planners.find((p) => p.id === id)?.program_id ?? null
    fetchMaster(supabase, prog ?? '').then(setMaster)
    const [lecRes, linkRes] = await Promise.all([
      supabase.from('planner_lectures').select('subject_id, faculty_id, chapter, topic_name, planned_date, start_time, duration_minutes').eq('planner_id', id).order('sequence_no', { ascending: true }),
      supabase.from('batch_planner_links').select('id, stage, batches(name)').eq('planner_id', id),
    ])
    setRows((lecRes.data ?? []).map((l) => ({
      subject_id: (l.subject_id as string) ?? '',
      faculty_id: (l.faculty_id as string) ?? '',
      chapter: (l.chapter as string) ?? '',
      topic_name: (l.topic_name as string) ?? '',
      planned_date: (l.planned_date as string) ?? '',
      start_time: l.start_time ? (l.start_time as string).slice(0, 5) : '',
      duration_minutes: String(l.duration_minutes ?? 60),
    })))
    setLinks((linkRes.data ?? []) as unknown as LinkLite[])
  }

  const updateRow = (i: number, patch: Partial<EditRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((prev) => [...prev, { subject_id: '', faculty_id: '', chapter: '', topic_name: '', planned_date: '', start_time: '', duration_minutes: '60' }])
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i))

  const handleSave = async () => {
    if (!selectedId) return
    setMessage(null)

    const clean: { subject_id: string | null; faculty_id: string | null; chapter: string; topic_name: string; planned_date: string; start_time: string | null; duration_minutes: number; sequence_no: number }[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const rn = i + 1
      if (!r.chapter.trim() || !r.topic_name.trim()) return setMessage({ type: 'error', text: `Row ${rn}: chapter & topic required.` })
      // Faculty is optional (Unassigned/TBD, fill in later).
      if (!parsePlannedDate(r.planned_date)) return setMessage({ type: 'error', text: `Row ${rn}: valid date required.` })
      const timeErr = validateOptionalTime(r.start_time)
      if (timeErr) return setMessage({ type: 'error', text: `Row ${rn}: ${timeErr}` })
      const dur = parseDuration(r.duration_minutes)
      if (!dur) return setMessage({ type: 'error', text: `Row ${rn}: duration must be 15–480 min.` })
      clean.push({
        subject_id: r.subject_id || null,
        faculty_id: r.faculty_id || null,
        chapter: r.chapter.trim(),
        topic_name: r.topic_name.trim(),
        planned_date: r.planned_date,
        start_time: r.start_time || null,
        duration_minutes: dur,
        sequence_no: i,
      })
    }
    if (clean.length === 0) return setMessage({ type: 'error', text: 'A planner needs at least one lecture.' })

    setSaving(true)
    // Replace all planner_lectures for this planner.
    await supabase.from('planner_lectures').delete().eq('planner_id', selectedId)
    const { error } = await supabase.from('planner_lectures').insert(clean.map((c) => ({ ...c, planner_id: selectedId })))
    if (error) { setSaving(false); setMessage({ type: 'error', text: error.message }); return }

    // Re-materialise links still editable (Draft / Rework). Leave sent/confirmed links alone.
    const editable = links.filter((l) => l.stage === 'Draft' || l.stage === 'Rework')
    const skipped = links.filter((l) => l.stage === 'Faculty Assigned' || l.stage === 'Confirmed')
    const remErrors: string[] = []
    for (const l of editable) {
      const res = await rematerialiseLink(supabase, l.id)
      if (res.errors.length) remErrors.push(`${batchName(l.batches)}: ${res.errors.slice(0, 1).join('')}`)
    }
    setSaving(false)

    let msg = `Planner saved (${clean.length} lecture(s)).`
    if (editable.length) msg += ` Re-materialised ${editable.length} draft link(s).`
    if (skipped.length) msg += ` ${skipped.length} link(s) already sent/confirmed were left unchanged.`
    if (remErrors.length) msg += ` Warnings: ${remErrors.slice(0, 2).join('; ')}`
    setMessage({ type: remErrors.length ? 'info' : 'success', text: msg })
    await selectPlanner(selectedId)
  }

  const inputClass = 'w-full h-9 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="space-y-6">
      <datalist id="ep-chapters">{chapterOptions.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="ep-topics">{topicOptions.map((t) => <option key={t} value={t} />)}</datalist>

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {selected && coverage && coverage.hasMaster && (
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
              <span key={s.subjectId} className={`text-xs px-2 py-1 rounded-lg border ${s.chaptersCovered === s.chaptersTotal ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}
                title={s.missing.length ? `Missing: ${s.missing.map((m) => m.chapter).join(', ')}` : 'Fully covered'}>
                {s.name}: {s.chaptersCovered}/{s.chaptersTotal}
              </span>
            ))}
          </div>
          {coverage.chaptersCovered < coverage.chaptersTotal && (
            <p className="text-xs text-neutral-400 mt-2">Hover a subject to see missing chapters. Use the chapter/topic suggestions so names match the master.</p>
          )}
        </Card>
      )}

      <Card className="p-6">
        <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Select Planner to Edit</label>
        <select value={selectedId} onChange={(e) => selectPlanner(e.target.value)} className="w-full sm:w-96 h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
          <option value="">{loading ? 'Loading…' : 'Choose a planner'}</option>
          {planners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {selected && links.length > 0 && (
          <p className="text-xs text-neutral-500 mt-3">
            Linked to {links.length} batch(es). Editing re-builds only <span className="font-semibold">Draft/Rework</span> links; already-sent or confirmed links stay put.
          </p>
        )}
      </Card>

      {selected && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-semibold text-neutral-950">Lectures — {selected.name}</h4>
            <BtnSecondary onClick={addRow}>+ Add Lecture</BtnSecondary>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-400 py-6 text-center">No lectures. Add one to begin.</p>
          ) : (
            <div className="overflow-x-auto border border-neutral-200 rounded-xl mb-4">
              <table className="w-full text-sm min-w-[960px]">
                <thead>
                  <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-semibold min-w-[140px]">Subject</th>
                    <th className="text-left px-3 py-2 font-semibold min-w-[170px]">Faculty</th>
                    <th className="text-left px-3 py-2 font-semibold">Chapter</th>
                    <th className="text-left px-3 py-2 font-semibold min-w-[150px]">Topic</th>
                    <th className="text-left px-3 py-2 font-semibold">Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Time</th>
                    <th className="text-left px-3 py-2 font-semibold">Mins</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">
                        <select value={r.subject_id} onChange={(e) => updateRow(i, { subject_id: e.target.value })} className={inputClass}>
                          <option value="">—</option>
                          {subjectPool.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select value={r.faculty_id} onChange={(e) => updateRow(i, { faculty_id: e.target.value })} className={inputClass}>
                          <option value="">Unassigned (TBD)</option>
                          {faculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input list="ep-chapters" value={r.chapter} onChange={(e) => updateRow(i, { chapter: e.target.value })} className={inputClass} placeholder="Ch 1" /></td>
                      <td className="px-3 py-2"><input list="ep-topics" value={r.topic_name} onChange={(e) => updateRow(i, { topic_name: e.target.value })} className={inputClass} placeholder="Topic" /></td>
                      <td className="px-3 py-2"><input type="date" value={r.planned_date} onChange={(e) => updateRow(i, { planned_date: e.target.value })} className={inputClass} /></td>
                      <td className="px-3 py-2"><input type="time" value={r.start_time} onChange={(e) => updateRow(i, { start_time: e.target.value })} className={inputClass} /></td>
                      <td className="px-3 py-2"><input type="number" min={15} max={480} value={r.duration_minutes} onChange={(e) => updateRow(i, { duration_minutes: e.target.value })} className={`${inputClass} w-20`} /></td>
                      <td className="px-2 py-2"><button onClick={() => removeRow(i)} className="text-red-500 hover:text-red-700 text-xs font-medium">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <BtnPrimary onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Planner'}</BtnPrimary>
        </Card>
      )}
    </div>
  )
}
