'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { fetchRoster, fetchResults, saveMarks, setTestMarksConfig, summarize, type ResultRow, type MarkEntry, type RosterStudent } from '@/lib/results'
import { parseCSVWithHeaders } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type TestRow = {
  id: string; batch_id: string; name: string; test_type: string; part_type: string
  test_date: string; start_time: string; stage: string; subject_id: string | null
  max_marks: number | null; pass_marks: number | null
}
// A CSV row previewed before saving (subjective upload).
type PreviewRow = { regno: string; name: string; marks: number | null; absent: boolean; skip: boolean; error: string }

const csvCell = (v: string) => (/[",\n]/.test(v ?? '') ? `"${(v ?? '').replace(/"/g, '""')}"` : (v ?? ''))
const ABSENT = /^(ab|absent|a)$/i

export default function MarksEntry({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [tests, setTests] = useState<TestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [batchId, setBatchId] = useState('')
  const [test, setTest] = useState<TestRow | null>(null)
  const [results, setResults] = useState<ResultRow[]>([])
  const [roster, setRoster] = useState<RosterStudent[]>([])
  const [entries, setEntries] = useState<MarkEntry[]>([])
  const [maxMarks, setMaxMarks] = useState('')
  const [passMarks, setPassMarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingTest, setLoadingTest] = useState(false)
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const objFileRef = useRef<HTMLInputElement>(null)
  const subFileRef = useRef<HTMLInputElement>(null)

  const isPrivileged = scope === 'central' || scope === 'admin'
  const canEditObjective = isPrivileged || scope === 'batch-manager'
  const canEditSubjective = isPrivileged || scope === 'branch'

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const [bRes, cRes, tRes] = await Promise.all([
        supabase.from('batches').select('id, name, centre_id, batch_manager_id').neq('status', 'Merged').order('name'),
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('test_schedules').select('id, batch_id, name, test_type, part_type, test_date, start_time, stage, subject_id, max_marks, pass_marks').order('test_date', { ascending: false }),
      ])
      if (bRes.data) setBatches(bRes.data as Batch[])
      if (cRes.data) setCentres(cRes.data as Centre[])
      if (tRes.data) setTests(tRes.data as TestRow[])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allowedCentreIds = useMemo(() => {
    if (isPrivileged) return new Set(centres.map((c) => c.id))
    const s = new Set<string>(getUserCentreIds(appUser))
    if (scope === 'branch' && appUser) centres.filter((c) => c.branch_head_id === appUser.id).forEach((c) => s.add(c.id))
    return s
  }, [appUser, centres, isPrivileged, scope])

  const visibleBatches = useMemo(() => {
    if (isPrivileged) return batches
    if (scope === 'batch-manager' && appUser) return batches.filter((b) => b.batch_manager_id === appUser.id)
    return batches.filter((b) => allowedCentreIds.has(b.centre_id)) // branch
  }, [batches, isPrivileged, scope, appUser, allowedCentreIds])

  // Only offer the test type this role can enter (objective for BM, subjective for branch).
  const batchTests = useMemo(() => {
    let list = tests.filter((t) => t.batch_id === batchId)
    if (scope === 'batch-manager') list = list.filter((t) => t.test_type === 'Objective')
    else if (scope === 'branch') list = list.filter((t) => t.test_type === 'Subjective')
    return list
  }, [tests, batchId, scope])

  const selectTest = async (t: TestRow | null) => {
    setTest(t); setMsg(null); setResults([]); setEntries([]); setRoster([]); setPreview(null)
    if (!t) return
    setLoadingTest(true)
    setMaxMarks(t.max_marks != null ? String(t.max_marks) : '')
    setPassMarks(t.pass_marks != null ? String(t.pass_marks) : '')
    const [res, rosterRes] = await Promise.all([fetchResults(supabase, t.id), fetchRoster(supabase, t.batch_id)])
    setResults(res)
    setRoster(rosterRes.students)
    if (rosterRes.students.length === 0 && res.length === 0) setMsg({ type: 'info', text: rosterRes.error ?? 'No students assigned to this batch yet — the Branch Head assigns them under Students.' })
    if (canEditObjective && t.test_type === 'Objective') {
      const byReg = new Map(res.map((r) => [r.regno, r]))
      const merged: MarkEntry[] = rosterRes.students.map((s) => {
        const ex = byReg.get(s.regno)
        return { regno: s.regno, student_name: s.name, marks: ex?.marks ?? null, absent: ex?.absent ?? false }
      })
      for (const r of res) if (!rosterRes.students.find((s) => s.regno === r.regno)) merged.push({ regno: r.regno, student_name: r.student_name, marks: r.marks, absent: r.absent })
      setEntries(merged)
    }
    setLoadingTest(false)
  }

  const numMax = maxMarks.trim() ? Number(maxMarks) : null
  const numPass = passMarks.trim() ? Number(passMarks) : null
  const summary = useMemo(() => summarize(results, numMax, numPass), [results, numMax, numPass])

  const updateEntry = (regno: string, patch: Partial<MarkEntry>) =>
    setEntries((prev) => prev.map((e) => (e.regno === regno ? { ...e, ...patch } : e)))

  const saveObjective = async () => {
    if (!test) return
    if (!numMax || numMax <= 0) return setMsg({ type: 'error', text: 'Set "Out of (max marks)" first.' })
    if (numPass != null && numPass > numMax) return setMsg({ type: 'error', text: 'Pass marks can’t exceed max marks.' })
    for (const e of entries) if (!e.absent && e.marks != null && (e.marks < 0 || e.marks > numMax)) return setMsg({ type: 'error', text: `${e.student_name || e.regno}: marks must be 0–${numMax}.` })
    setSaving(true)
    await setTestMarksConfig(supabase, test.id, numMax, numPass)
    const res = await saveMarks(supabase, test.id, entries.filter((e) => e.absent || e.marks != null), 'objective')
    setSaving(false)
    if (!res.ok) return setMsg({ type: 'error', text: res.error ?? 'Save failed.' })
    setTest({ ...test, max_marks: numMax, pass_marks: numPass })
    setMsg({ type: 'success', text: `Saved marks for ${res.saved} student(s).` })
    setResults(await fetchResults(supabase, test.id))
  }

  function downloadTemplate() {
    const header = ['Regno', 'Name', 'Marks']
    const lines = [header.join(',')]
    for (const s of roster) lines.push([s.regno, s.name, ''].map(csvCell).join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${test?.name || 'test'}-marks.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // Objective: CSV just fills the editable grid; user reviews then Saves.
  async function handleObjectiveCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      const iReg = headers.findIndex((h) => ['regno', 'reg', 'roll', 'student id', 'sid'].some((k) => h.includes(k)))
      const iMarks = headers.findIndex((h) => h.includes('marks') || h.includes('score'))
      if (iReg < 0 || iMarks < 0) { setMsg({ type: 'error', text: 'CSV needs Regno and Marks columns.' }); return }
      const byReg = new Map<string, { marks: number | null; absent: boolean }>()
      for (const row of rows) {
        const regno = (row[iReg] ?? '').trim()
        if (!regno) continue
        const raw = (row[iMarks] ?? '').trim()
        const absent = ABSENT.test(raw)
        const marks = absent || raw === '' ? null : Number(raw)
        if (!absent && raw !== '' && Number.isNaN(marks)) continue
        byReg.set(regno, { marks, absent })
      }
      let filled = 0, unknown = 0
      const known = new Set(entries.map((en) => en.regno))
      for (const k of byReg.keys()) if (!known.has(k)) unknown++
      setEntries((prev) => prev.map((en) => { const c = byReg.get(en.regno); if (!c) return en; filled++; return { ...en, marks: c.absent ? null : c.marks, absent: c.absent } }))
      setMsg({ type: unknown ? 'info' : 'success', text: `Filled ${filled} student(s) from CSV${unknown ? ` · ${unknown} regno(s) not in this batch (ignored)` : ''}. Review, then Save marks.` })
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      if (objFileRef.current) objFileRef.current.value = ''
    }
  }

  // Subjective: CSV → validated preview → apply.
  async function handleSubjectiveCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !test) return
    if (!numMax || numMax <= 0) { setMsg({ type: 'error', text: 'Set "Out of (max marks)" above before uploading.' }); if (subFileRef.current) subFileRef.current.value = ''; return }
    setMsg(null)
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      const iReg = headers.findIndex((h) => ['regno', 'reg', 'roll', 'student id', 'sid'].some((k) => h.includes(k)))
      const iName = headers.findIndex((h) => h.includes('name'))
      const iMarks = headers.findIndex((h) => h.includes('marks') || h.includes('score'))
      if (iReg < 0 || iMarks < 0) { setMsg({ type: 'error', text: 'CSV needs Regno and Marks columns.' }); return }
      const rosterByReg = new Map(roster.map((s) => [s.regno.trim(), s]))
      const byReg = new Map<string, PreviewRow>()
      for (const row of rows) {
        const regno = (row[iReg] ?? '').trim()
        if (!regno) continue
        const raw = (row[iMarks] ?? '').trim()
        const student = rosterByReg.get(regno)
        const name = student?.name ?? (iName >= 0 ? (row[iName] ?? '').trim() : '')
        let marks: number | null = null, absent = false, error = '', skip = false
        if (!student) error = 'Not assigned to this batch'
        else if (ABSENT.test(raw)) absent = true
        else if (raw === '') skip = true // blank = leave unchanged
        else {
          marks = Number(raw)
          if (Number.isNaN(marks)) error = `“${raw}” is not a number`
          else if (marks < 0 || marks > numMax) error = `Marks must be 0–${numMax}`
        }
        byReg.set(regno, { regno, name, marks, absent, skip, error })
      }
      const rowsOut = Array.from(byReg.values())
      if (rowsOut.length === 0) { setMsg({ type: 'error', text: 'No rows found in the CSV.' }); return }
      setPreview(rowsOut)
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      if (subFileRef.current) subFileRef.current.value = ''
    }
  }

  async function applySubjective() {
    if (!test || !preview) return
    const valid = preview.filter((r) => !r.error && !r.skip)
    if (valid.length === 0) { setMsg({ type: 'error', text: 'Nothing to import — every row has an error or is blank.' }); return }
    setSaving(true)
    await setTestMarksConfig(supabase, test.id, numMax, numPass)
    const res = await saveMarks(supabase, test.id, valid.map((r) => ({ regno: r.regno, student_name: r.name, marks: r.marks, absent: r.absent })), 'subjective')
    setSaving(false)
    if (!res.ok) { setMsg({ type: 'error', text: res.error ?? 'Import failed.' }); return }
    setPreview(null)
    setMsg({ type: 'success', text: `Imported subjective marks for ${res.saved} student(s).` })
    setResults(await fetchResults(supabase, test.id))
  }

  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const input = 'h-9 px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const objectiveEntry = canEditObjective && test?.test_type === 'Objective'
  const viewRows = objectiveEntry ? entries : results.map((r) => ({ regno: r.regno, student_name: r.student_name, marks: r.marks, absent: r.absent }))

  const desc = isPrivileged ? 'Enter marks per test. Objective as a grid (or CSV), subjective via CSV.'
    : scope === 'batch-manager' ? 'Enter objective test marks for your batches — earned / out of total.'
    : 'Upload subjective marks (CSV) for your centre’s batches.'

  const previewErrors = preview?.filter((r) => r.error).length ?? 0
  const previewSkips = preview?.filter((r) => !r.error && r.skip).length ?? 0
  const previewOk = preview?.filter((r) => !r.error && !r.skip).length ?? 0

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Marks Entry" description={desc} />
      {msg && <Alert type={msg.type === 'info' ? 'info' : msg.type}>{msg.text}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => { setBatchId(e.target.value); selectTest(null) }} className="h-11 min-w-[240px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
            <option value="">{loading ? 'Loading…' : 'Select a batch'}</option>
            {visibleBatches.map((b) => <option key={b.id} value={b.id}>{b.name}{isPrivileged ? ` — ${centreName(b.centre_id)}` : ''}</option>)}
          </select>
        </div>
        {batchId && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Test</label>
            <select value={test?.id ?? ''} onChange={(e) => selectTest(batchTests.find((t) => t.id === e.target.value) ?? null)} className="h-11 min-w-[280px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
              <option value="">{batchTests.length ? 'Select a test' : `No ${scope === 'branch' ? 'subjective' : scope === 'batch-manager' ? 'objective' : ''} tests for this batch`}</option>
              {batchTests.map((t) => <option key={t.id} value={t.id}>{t.name} · {new Date(t.test_date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {t.test_type}</option>)}
            </select>
          </div>
        )}
      </div>

      {!test ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch and a test to enter marks.</Card>
      ) : loadingTest ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : (
        <div className="space-y-6">
          <Card className="p-5">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">Test</span>
                <p className="font-bold text-neutral-950">{test.name} <span className="text-xs font-medium text-neutral-500">· {test.test_type} · {test.part_type === 'Full' ? 'Full syllabus' : 'Part'}</span></p>
              </div>
              <div className="ml-auto flex items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1">Out of (max)</label>
                  <input type="number" min={1} value={maxMarks} onChange={(e) => setMaxMarks(e.target.value)} className={`${input} w-24`} placeholder="e.g. 100" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1">Pass marks</label>
                  <input type="number" min={0} value={passMarks} onChange={(e) => setPassMarks(e.target.value)} className={`${input} w-24`} placeholder="optional" />
                </div>
              </div>
            </div>
            <p className="text-xs text-neutral-400 mt-2">Saved so far: <b>{summary.attempted}</b> attempted{summary.absent ? `, ${summary.absent} absent` : ''}{summary.average != null ? ` · avg ${summary.average}${summary.avgPct != null ? ` (${summary.avgPct}%)` : ''}` : ''}. Full performance is in Results.</p>
          </Card>

          {canEditSubjective && test.test_type === 'Subjective' && (
            <Card className="p-5 bg-violet-50 border-violet-200">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h4 className="font-semibold text-violet-900">Subjective marks — CSV upload</h4>
                  <p className="text-xs text-violet-800">Set “Out of” above, then upload. Columns: <code className="bg-white px-1 rounded">Regno, Marks</code> (Name optional; “AB” = absent). You’ll review before it saves.</p>
                </div>
                <div className="flex gap-2">
                  <BtnSecondary onClick={downloadTemplate} disabled={roster.length === 0}>Download template</BtnSecondary>
                  <label className={`inline-flex items-center h-10 px-4 rounded-lg text-sm font-semibold cursor-pointer ${saving ? 'bg-neutral-300 text-white' : 'bg-violet-600 hover:bg-violet-700 text-white'}`}>
                    {saving ? 'Working…' : 'Upload CSV'}
                    <input ref={subFileRef} type="file" accept=".csv" className="sr-only" onChange={handleSubjectiveCSV} disabled={saving} />
                  </label>
                </div>
              </div>
            </Card>
          )}

          {test.test_type === 'Objective' && !canEditObjective && <Alert type="info">Objective marks are entered by the Batch Manager.</Alert>}
          {test.test_type === 'Subjective' && !canEditSubjective && <Alert type="info">Subjective marks are uploaded by the Branch Head.</Alert>}

          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between gap-3 flex-wrap">
              <h4 className="font-semibold text-neutral-950">Students {objectiveEntry ? '— enter earned marks' : ''}</h4>
              {objectiveEntry && (
                <div className="flex gap-2">
                  <BtnSecondary onClick={downloadTemplate} disabled={roster.length === 0}>Template</BtnSecondary>
                  <label className="inline-flex items-center h-10 px-4 rounded-lg text-sm font-semibold cursor-pointer bg-neutral-100 hover:bg-neutral-200 text-neutral-700">
                    Upload CSV
                    <input ref={objFileRef} type="file" accept=".csv" className="sr-only" onChange={handleObjectiveCSV} />
                  </label>
                  <BtnPrimary onClick={saveObjective} disabled={saving}>{saving ? 'Saving…' : 'Save marks'}</BtnPrimary>
                </div>
              )}
            </div>
            {viewRows.length === 0 ? (
              <p className="p-6 text-sm text-neutral-400">{objectiveEntry ? 'No students assigned to this batch yet — Branch Head assigns them under Students.' : 'No marks entered yet.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-5 py-2">Reg no.</th><th className="px-3 py-2">Student</th><th className="px-3 py-2 w-40">Marks{numMax ? ` / ${numMax}` : ''}</th><th className="px-3 py-2 w-24">Absent</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {viewRows.map((r) => (
                      <tr key={r.regno} className="hover:bg-neutral-50/60">
                        <td className="px-5 py-2 font-mono text-xs text-neutral-500">{r.regno}</td>
                        <td className="px-3 py-2 text-neutral-900">{r.student_name || '—'}</td>
                        <td className="px-3 py-2">
                          {objectiveEntry ? (
                            <input type="number" min={0} max={numMax ?? undefined} value={r.marks ?? ''} disabled={r.absent} onChange={(e) => updateEntry(r.regno, { marks: e.target.value === '' ? null : Number(e.target.value) })} className={`${input} w-28`} />
                          ) : (
                            <span className={`font-semibold ${r.absent ? 'text-rose-500' : 'text-neutral-900'}`}>{r.absent ? 'Absent' : (r.marks ?? '—')}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {objectiveEntry ? (
                            <input type="checkbox" checked={r.absent} onChange={(e) => updateEntry(r.regno, { absent: e.target.checked, marks: e.target.checked ? null : r.marks })} />
                          ) : (r.absent ? '✓' : '')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Subjective CSV preview */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-neutral-200 flex flex-col max-h-[85vh]">
            <div className="p-6 border-b border-neutral-100">
              <h3 className="text-xl font-bold text-neutral-950 mb-1">Review subjective marks</h3>
              <p className="text-sm text-neutral-500"><span className="text-emerald-600 font-medium">{previewOk} to import</span> · <span className="text-rose-600 font-medium">{previewErrors} error(s)</span> · {previewSkips} blank. Errors are skipped.</p>
            </div>
            <div className="overflow-auto p-4">
              <table className="w-full text-left text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Regno</th><th className="px-3 py-2">Student</th><th className="px-3 py-2">Marks</th><th className="px-3 py-2">Note</th></tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {preview.map((r, i) => (
                    <tr key={i} className={r.error ? 'bg-rose-50/60' : r.skip ? '' : ''}>
                      <td className="px-3 py-2 font-mono text-xs text-neutral-500">{r.regno}</td>
                      <td className="px-3 py-2">{r.name || '—'}</td>
                      <td className="px-3 py-2">{r.error ? '—' : r.skip ? <span className="text-neutral-400">blank</span> : r.absent ? <span className="text-rose-500 font-medium">Absent</span> : r.marks}</td>
                      <td className="px-3 py-2 text-xs">{r.error ? <span className="text-rose-600">{r.error}</span> : r.skip ? '' : <span className="text-emerald-600">ok</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-6 border-t border-neutral-100 flex gap-3">
              <BtnPrimary onClick={applySubjective} disabled={saving || previewOk === 0}>{saving ? 'Importing…' : `Import ${previewOk} mark(s)`}</BtnPrimary>
              <BtnSecondary onClick={() => setPreview(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
