'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { fetchRoster, fetchResults, saveMarks, setTestMarksConfig, summarize, type ResultRow, type MarkEntry } from '@/lib/results'
import { parseCSVWithHeaders } from '@/lib/utils'
import { Alert, BtnPrimary, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type TestRow = {
  id: string; batch_id: string; name: string; test_type: string; part_type: string
  test_date: string; start_time: string; stage: string; subject_id: string | null
  max_marks: number | null; pass_marks: number | null
}

// Marks entry only: batch managers key objective marks; branch heads upload
// subjective CSVs. The batch-wise performance summary lives in Results.
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
  const [entries, setEntries] = useState<MarkEntry[]>([])
  const [maxMarks, setMaxMarks] = useState('')
  const [passMarks, setPassMarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingTest, setLoadingTest] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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
        supabase.from('batches').select('id, name, centre_id, batch_manager_id').order('name'),
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
    setTest(t); setMsg(null); setResults([]); setEntries([])
    if (!t) return
    setLoadingTest(true)
    setMaxMarks(t.max_marks != null ? String(t.max_marks) : '')
    setPassMarks(t.pass_marks != null ? String(t.pass_marks) : '')
    const res = await fetchResults(supabase, t.id)
    setResults(res)
    if (canEditObjective && t.test_type === 'Objective') {
      const { students, error } = await fetchRoster(supabase, t.batch_id)
      if (error && students.length === 0 && res.length === 0) setMsg({ type: 'info', text: error })
      const byReg = new Map(res.map((r) => [r.regno, r]))
      const merged: MarkEntry[] = students.map((s) => {
        const ex = byReg.get(s.regno)
        return { regno: s.regno, student_name: s.name, marks: ex?.marks ?? null, absent: ex?.absent ?? false }
      })
      for (const r of res) if (!students.find((s) => s.regno === r.regno)) merged.push({ regno: r.regno, student_name: r.student_name, marks: r.marks, absent: r.absent })
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
    if (!numMax) return setMsg({ type: 'error', text: 'Set "Out of (max marks)" first.' })
    for (const e of entries) if (!e.absent && e.marks != null && (e.marks < 0 || e.marks > numMax)) return setMsg({ type: 'error', text: `${e.student_name}: marks must be 0–${numMax}.` })
    setSaving(true)
    await setTestMarksConfig(supabase, test.id, numMax, numPass)
    const res = await saveMarks(supabase, test.id, entries.filter((e) => e.absent || e.marks != null), 'objective')
    setSaving(false)
    if (!res.ok) return setMsg({ type: 'error', text: res.error ?? 'Save failed.' })
    setTest({ ...test, max_marks: numMax, pass_marks: numPass })
    setMsg({ type: 'success', text: `Saved marks for ${res.saved} student(s).` })
    setResults(await fetchResults(supabase, test.id))
  }

  const handleSubjectiveCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !test) return
    setSaving(true); setMsg(null)
    try {
      if (numMax) await setTestMarksConfig(supabase, test.id, numMax, numPass)
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      const iReg = headers.findIndex((h) => h.includes('regno') || h.includes('reg') || h.includes('roll') || h.includes('student id'))
      const iName = headers.findIndex((h) => h.includes('name'))
      const iMarks = headers.findIndex((h) => h.includes('marks') || h.includes('score'))
      if (iReg < 0 || iMarks < 0) { setMsg({ type: 'error', text: 'CSV needs Regno and Marks columns.' }); return }
      const list: MarkEntry[] = []
      for (const row of rows) {
        const regno = (row[iReg] ?? '').trim()
        if (!regno) continue
        const raw = (row[iMarks] ?? '').trim()
        const absent = /^(ab|absent|a)$/i.test(raw)
        const marks = absent ? null : (raw === '' ? null : Number(raw))
        if (!absent && marks != null && Number.isNaN(marks)) continue
        list.push({ regno, student_name: iName >= 0 ? (row[iName] ?? '').trim() : '', marks, absent })
      }
      if (list.length === 0) { setMsg({ type: 'error', text: 'No valid rows in the CSV.' }); return }
      const res = await saveMarks(supabase, test.id, list, 'subjective')
      if (!res.ok) { setMsg({ type: 'error', text: res.error ?? 'Import failed.' }); return }
      setMsg({ type: 'success', text: `Imported subjective marks for ${res.saved} student(s).` })
      setResults(await fetchResults(supabase, test.id))
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      setSaving(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const input = 'h-9 px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const objectiveEntry = canEditObjective && test?.test_type === 'Objective'
  const viewRows = objectiveEntry ? entries : results.map((r) => ({ regno: r.regno, student_name: r.student_name, marks: r.marks, absent: r.absent }))

  const desc = isPrivileged ? 'Enter marks per test. Objective as a grid, subjective via CSV.'
    : scope === 'batch-manager' ? 'Enter objective test marks for your batches — earned / out of total.'
    : 'Upload subjective marks (CSV) for your centre’s batches.'

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
                  <p className="text-xs text-violet-800">Set “Out of” above, then upload. Columns: <code className="bg-white px-1 rounded">Regno, Marks</code> (Name optional; “AB” = absent).</p>
                </div>
                <label className={`inline-flex items-center h-10 px-4 rounded-lg text-sm font-semibold cursor-pointer ${saving ? 'bg-neutral-300 text-white' : 'bg-violet-600 hover:bg-violet-700 text-white'}`}>
                  {saving ? 'Uploading…' : 'Upload CSV'}
                  <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleSubjectiveCSV} disabled={saving} />
                </label>
              </div>
            </Card>
          )}

          {test.test_type === 'Objective' && !canEditObjective && (
            <Alert type="info">Objective marks are entered by the Batch Manager.</Alert>
          )}
          {test.test_type === 'Subjective' && !canEditSubjective && (
            <Alert type="info">Subjective marks are uploaded by the Branch Head.</Alert>
          )}

          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
              <h4 className="font-semibold text-neutral-950">Students {objectiveEntry ? '— enter earned marks' : ''}</h4>
              {objectiveEntry && <BtnPrimary onClick={saveObjective} disabled={saving}>{saving ? 'Saving…' : 'Save marks'}</BtnPrimary>}
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
    </div>
  )
}
