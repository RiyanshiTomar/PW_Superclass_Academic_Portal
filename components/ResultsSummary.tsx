'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { activeBatchStudents } from '@/lib/students'
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { summarize, type ResultRow } from '@/lib/results'
import { passRuleFor, passMarksFor } from '@/lib/passing'
import { Alert, Card, PageHeader } from '@/components/PortalShell'
import TestWiseResults from '@/components/TestWiseResults'
import { seriesOf } from '@/lib/series'

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager' | 'faculty'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null; programs?: { name: string } | { name: string }[] | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type TestRow = { id: string; batch_id: string; subject_id: string | null; name: string; test_type: string; part_type: string; test_date: string; max_marks: number | null; pass_marks: number | null }
type Result = ResultRow & { test_id: string }

const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

export default function ResultsSummary({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [facultyBatchIds, setFacultyBatchIds] = useState<Set<string>>(new Set())
  const [tests, setTests] = useState<TestRow[]>([])
  const [batchId, setBatchId] = useState('')
  const [filterCentre, setFilterCentre] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [studentCount, setStudentCount] = useState(0)
  const [roster, setRoster] = useState<{ regno: string; student_name: string | null }[]>([])
  const [subjectNames, setSubjectNames] = useState<Map<string, string>>(new Map())
  const [view, setView] = useState<'batch' | 'test'>('batch')
  const [seriesKey, setSeriesKey] = useState<string | undefined>(undefined)
  const [mappedByBatch, setMappedByBatch] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [loadingBatch, setLoadingBatch] = useState(false)

  const isPrivileged = scope === 'central' || scope === 'admin'

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const [bRes, cRes, tRes] = await Promise.all([
        supabase.from('batches').select('id, name, centre_id, batch_manager_id, programs(name)').order('name'),
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        fetchAll<TestRow>((from, to) => supabase.from('test_schedules').select('id, batch_id, subject_id, name, test_type, part_type, test_date, max_marks, pass_marks').neq('stage', 'Cancelled').order('test_date', { ascending: true }).order('id').range(from, to)),
      ])
      if (bRes.data) setBatches(bRes.data as Batch[])
      if (cRes.data) setCentres(cRes.data as Centre[])
      setTests(tRes.data)
      // Multi-batch tests count for every batch they're mapped to.
      const { data: maps } = await fetchAll<{ test_id: string; batch_id: string }>((from, to) => supabase.from('test_batch_mappings').select('test_id, batch_id').order('test_id').order('batch_id').range(from, to))
      const m: Record<string, string[]> = {}
      for (const r of maps) (m[r.batch_id] ??= []).push(r.test_id)
      setMappedByBatch(m)
      if (scope === 'faculty' && au) {
        const { data: sch } = await supabase.from('batch_schedules').select('batch_id').eq('faculty_id', au.id)
        setFacultyBatchIds(new Set((sch ?? []).map((r) => r.batch_id as string)))
      }
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
    if (scope === 'faculty') return batches.filter((b) => facultyBatchIds.has(b.id))
    return batches.filter((b) => allowedCentreIds.has(b.centre_id))
  }, [batches, isPrivileged, scope, appUser, allowedCentreIds, facultyBatchIds])

  const rule = useMemo(() => {
    const b = batches.find((x) => x.id === batchId)
    const prog = Array.isArray(b?.programs) ? b?.programs[0] : b?.programs
    return passRuleFor(prog?.name)
  }, [batches, batchId])

  const batchTests = useMemo(() => {
    const mapped = new Set(mappedByBatch[batchId] ?? [])
    return tests.filter((t) => t.batch_id === batchId || mapped.has(t.id))
  }, [tests, batchId, mappedByBatch])

  const filteredBatches = useMemo(() => {
    if (!filterCentre) return visibleBatches
    return visibleBatches.filter((b) => b.centre_id === filterCentre)
  }, [visibleBatches, filterCentre])

  const visibleCentres = useMemo(() => {
    if (isPrivileged) return centres
    return centres.filter((c) => allowedCentreIds.has(c.id))
  }, [centres, isPrivileged, allowedCentreIds])

  useEffect(() => {
    if (!batchId) { setResults([]); setStudentCount(0); setRoster([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingBatch(true)
      const own = new Set(tests.filter((t) => t.batch_id === batchId).map((t) => t.id))
      const testIds = batchTests.map((t) => t.id)
      // Paged + chunked: a batch's marks easily pass PostgREST's 1000-row cap
      // (77 students × 16 tests), which silently dropped later tests' results.
      const subjIds = Array.from(new Set(batchTests.map((t) => t.subject_id).filter((x): x is string => !!x)))
      const [rRes, sRes, subjRes] = await Promise.all([
        fetchAllIn<Result>(testIds, (chunk, from, to) => supabase.from('test_results').select('test_id, regno, student_name, marks, absent, source').in('test_id', chunk).order('test_id').order('regno').range(from, to)),
        activeBatchStudents(supabase, batchId),
        subjIds.length ? supabase.from('subjects').select('id, name').in('id', subjIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ])
      if (cancelled) return
      // A multi-batch test holds every batch's students — keep this batch's only.
      const regnos = new Set(sRes.data.map((r) => r.regno))
      setResults(rRes.data.filter((r) => own.has(r.test_id) || regnos.has(r.regno)))
      setStudentCount(sRes.data.length)
      setRoster(sRes.data)
      setSubjectNames(new Map(((subjRes.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])))
      setLoadingBatch(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, batchTests])

  // Per-test summary using each test's own max/pass.
  const perTest = useMemo(() => {
    return batchTests.map((t) => {
      const rows = results.filter((r) => r.test_id === t.id)
      // Pass mark: the test's own, else the program's passing criteria.
      return { test: t, summary: summarize(rows, t.max_marks, passMarksFor(t, rule)), rows }
    })
  }, [batchTests, results, rule])

  // Overall = mean of each test's avg% / pass% (only tests that have marks).
  const overall = useMemo(() => {
    const withData = perTest.filter((p) => p.summary.attempted > 0)
    const avgPcts = withData.map((p) => p.summary.avgPct).filter((x): x is number => x != null)
    const passPcts = withData.map((p) => p.summary.passPct).filter((x): x is number => x != null)
    const mean = (a: number[]) => (a.length ? Math.round((a.reduce((s, n) => s + n, 0) / a.length) * 10) / 10 : null)
    return { conducted: withData.length, totalTests: batchTests.length, avgPct: mean(avgPcts), passPct: mean(passPcts) }
  }, [perTest, batchTests])

  // Toppers: each student's average % across the tests they attempted.
  // Toppers by overall score: total marks ÷ total max over the tests held,
  // an Absent counting as 0 — one good test can't put a student on top.
  const toppers = useMemo(() => {
    const maxByTest = new Map(batchTests.map((t) => [t.id, t.max_marks]))
    const agg = new Map<string, { name: string; got: number; max: number; tests: number }>()
    for (const r of results) {
      const max = maxByTest.get(r.test_id)
      if (!max || (!r.absent && r.marks == null)) continue
      const cur = agg.get(r.regno) ?? { name: r.student_name, got: 0, max: 0, tests: 0 }
      cur.max += max; cur.got += r.absent ? 0 : (r.marks as number)
      if (!r.absent) cur.tests += 1
      if (r.student_name) cur.name = r.student_name
      agg.set(r.regno, cur)
    }
    return Array.from(agg.entries())
      .filter(([, v]) => v.max > 0)
      .map(([regno, v]) => ({ regno, name: v.name, avgPct: Math.round((v.got / v.max) * 1000) / 10, tests: v.tests }))
      .sort((a, b) => b.avgPct - a.avgPct || b.tests - a.tests)
      .slice(0, 8)
  }, [results, batchTests])

  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const tile = 'rounded-2xl p-4 border shadow-sm'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Results" description="Batch-wise performance across all tests — averages, pass %, and top performers." />

      <div className="flex flex-wrap items-end gap-3 mb-6">
        {isPrivileged && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={filterCentre} onChange={(e) => { setFilterCentre(e.target.value); setBatchId('') }} className="h-11 min-w-[200px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">All centres</option>
              {visibleCentres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => { setBatchId(e.target.value); setSeriesKey(undefined) }} className="h-11 min-w-[240px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
            <option value="">{loading ? 'Loading…' : 'Select a batch'}</option>
            {filteredBatches.map((b) => <option key={b.id} value={b.id}>{b.name}{isPrivileged ? ` — ${centreName(b.centre_id)}` : ''}</option>)}
          </select>
        </div>
        {batchId && (
          <div className="flex rounded-xl border border-neutral-200 bg-white p-1 text-sm font-semibold">
            {([['batch', 'Batch summary'], ['test', 'Test-wise']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setView(k)} className={`px-4 h-9 rounded-lg ${view === k ? 'bg-violet-600 text-white' : 'text-neutral-600 hover:bg-violet-50'}`}>{t}</button>
            ))}
          </div>
        )}
      </div>

      {!batchId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch to see its performance.</Card>
      ) : loadingBatch ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : batchTests.length === 0 ? (
        <Alert type="info">No tests scheduled for this batch yet.</Alert>
      ) : view === 'test' ? (
        <TestWiseResults
          key={`${batchId}|${seriesKey ?? ''}`}
          tests={batchTests.filter((t) => t.test_date <= new Date().toISOString().slice(0, 10) || results.some((r) => r.test_id === t.id && (r.absent || r.marks != null)))}
          results={results}
          students={roster}
          rule={rule}
          subjectNames={subjectNames}
          batchName={batches.find((b) => b.id === batchId)?.name ?? ''}
          initialKey={seriesKey}
        />
      ) : (
        <div className="space-y-6">
          {/* Overall tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className={`${tile} border-violet-100 bg-gradient-to-br from-violet-50 to-white`}><div className="text-3xl font-black text-violet-600">{overall.conducted}<span className="text-lg text-neutral-400">/{overall.totalTests}</span></div><div className="text-xs font-medium text-violet-900/60 mt-1">Tests with marks</div></div>
            <div className={`${tile} border-sky-100 bg-gradient-to-br from-sky-50 to-white`}><div className="text-3xl font-black text-sky-600">{studentCount || '—'}</div><div className="text-xs font-medium text-sky-900/60 mt-1">Students in batch</div></div>
            <div className={`${tile} border-emerald-100 bg-gradient-to-br from-emerald-50 to-white`}><div className="text-3xl font-black text-emerald-600">{overall.avgPct != null ? `${overall.avgPct}%` : '—'}</div><div className="text-xs font-medium text-emerald-900/60 mt-1">Avg score %</div></div>
            <div className={`${tile} border-amber-100 bg-gradient-to-br from-amber-50 to-white`}><div className="text-3xl font-black text-amber-600">{overall.passPct != null ? `${overall.passPct}%` : '—'}</div><div className="text-xs font-medium text-amber-900/60 mt-1">Avg pass %</div></div>
          </div>

          {/* Toppers */}
          <Card className="p-5">
            <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3">Top performers</h4>
            {toppers.length === 0 ? (
              <p className="text-sm text-neutral-400">No marks entered yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {toppers.map((t, i) => (
                  <div key={t.regno} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${i === 0 ? 'bg-amber-50 border-amber-200' : 'bg-neutral-50 border-neutral-200'}`}>
                    <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${i === 0 ? 'bg-amber-400 text-white' : 'bg-neutral-200 text-neutral-600'}`}>{i + 1}</span>
                    <div>
                      <div className="text-sm font-semibold text-neutral-900">{t.name || t.regno}</div>
                      <div className="text-[11px] text-neutral-500">{t.avgPct}% · {t.tests} test{t.tests === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Per-test breakdown */}
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-baseline justify-between"><h4 className="font-semibold text-neutral-950">Test-by-test</h4><span className="text-xs text-neutral-400">Click a test for its student-wise view</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="px-5 py-2">Test</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Attempted</th><th className="px-3 py-2">Avg</th><th className="px-3 py-2">Avg %</th><th className="px-3 py-2">Pass %</th>
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {perTest.map(({ test, summary }) => (
                    <tr key={test.id} onClick={() => { if (summary.entered > 0) { setSeriesKey(seriesOf(test.name).key); setView('test') } }} className={`hover:bg-neutral-50/60 ${summary.entered > 0 ? 'cursor-pointer' : ''}`} title={summary.entered > 0 ? 'Open test-wise view' : undefined}>
                      <td className="px-5 py-2 font-medium text-neutral-900">{test.name}</td>
                      <td className="px-3 py-2 text-neutral-500">{fmtDate(test.test_date)}</td>
                      <td className="px-3 py-2 text-neutral-500">{test.test_type}</td>
                      <td className="px-3 py-2">{summary.attempted}{summary.absent ? ` · ${summary.absent} ab` : ''}</td>
                      <td className="px-3 py-2">{summary.average ?? '—'}{test.max_marks ? <span className="text-neutral-400"> / {test.max_marks}</span> : ''}</td>
                      <td className="px-3 py-2 font-semibold">{summary.avgPct != null ? `${summary.avgPct}%` : '—'}</td>
                      <td className={`px-3 py-2 font-semibold ${summary.passPct == null ? 'text-neutral-300' : summary.passPct >= 60 ? 'text-emerald-600' : 'text-amber-600'}`}>{summary.passPct != null ? `${summary.passPct}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
