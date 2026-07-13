'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { summarize, type ResultRow } from '@/lib/results'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager' | 'faculty'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type TestRow = { id: string; batch_id: string; name: string; test_type: string; test_date: string; max_marks: number | null; pass_marks: number | null }
type Result = ResultRow & { test_id: string }

const pct = (marks: number, max: number | null) => (max ? (marks / max) * 100 : null)
const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

export default function ResultsSummary({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [facultyBatchIds, setFacultyBatchIds] = useState<Set<string>>(new Set())
  const [tests, setTests] = useState<TestRow[]>([])
  const [batchId, setBatchId] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [studentCount, setStudentCount] = useState(0)
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
        supabase.from('batches').select('id, name, centre_id, batch_manager_id').order('name'),
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('test_schedules').select('id, batch_id, name, test_type, test_date, max_marks, pass_marks').order('test_date', { ascending: true }),
      ])
      if (bRes.data) setBatches(bRes.data as Batch[])
      if (cRes.data) setCentres(cRes.data as Centre[])
      if (tRes.data) setTests(tRes.data as TestRow[])
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

  const batchTests = useMemo(() => tests.filter((t) => t.batch_id === batchId), [tests, batchId])

  useEffect(() => {
    if (!batchId) { setResults([]); setStudentCount(0); return }
    let cancelled = false
    ;(async () => {
      setLoadingBatch(true)
      const testIds = tests.filter((t) => t.batch_id === batchId).map((t) => t.id)
      const [rRes, sRes] = await Promise.all([
        testIds.length ? supabase.from('test_results').select('test_id, regno, student_name, marks, absent, source').in('test_id', testIds) : Promise.resolve({ data: [] }),
        supabase.from('students').select('id', { count: 'exact', head: true }).eq('batch_id', batchId),
      ])
      if (cancelled) return
      setResults((rRes.data ?? []) as Result[])
      setStudentCount((sRes as { count?: number }).count ?? 0)
      setLoadingBatch(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  // Per-test summary using each test's own max/pass.
  const perTest = useMemo(() => {
    return batchTests.map((t) => {
      const rows = results.filter((r) => r.test_id === t.id)
      return { test: t, summary: summarize(rows, t.max_marks, t.pass_marks), rows }
    })
  }, [batchTests, results])

  // Overall = mean of each test's avg% / pass% (only tests that have marks).
  const overall = useMemo(() => {
    const withData = perTest.filter((p) => p.summary.attempted > 0)
    const avgPcts = withData.map((p) => p.summary.avgPct).filter((x): x is number => x != null)
    const passPcts = withData.map((p) => p.summary.passPct).filter((x): x is number => x != null)
    const mean = (a: number[]) => (a.length ? Math.round((a.reduce((s, n) => s + n, 0) / a.length) * 10) / 10 : null)
    return { conducted: withData.length, totalTests: batchTests.length, avgPct: mean(avgPcts), passPct: mean(passPcts) }
  }, [perTest, batchTests])

  // Toppers: each student's average % across the tests they attempted.
  const toppers = useMemo(() => {
    const maxByTest = new Map(batchTests.map((t) => [t.id, t.max_marks]))
    const agg = new Map<string, { name: string; sum: number; n: number }>()
    for (const r of results) {
      if (r.absent || r.marks == null) continue
      const p = pct(r.marks, maxByTest.get(r.test_id) ?? null)
      if (p == null) continue
      const cur = agg.get(r.regno) ?? { name: r.student_name, sum: 0, n: 0 }
      cur.sum += p; cur.n += 1; if (r.student_name) cur.name = r.student_name
      agg.set(r.regno, cur)
    }
    return Array.from(agg.entries())
      .map(([regno, v]) => ({ regno, name: v.name, avgPct: Math.round((v.sum / v.n) * 10) / 10, tests: v.n }))
      .sort((a, b) => b.avgPct - a.avgPct)
      .slice(0, 8)
  }, [results, batchTests])

  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const tile = 'rounded-2xl p-4 border shadow-sm'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Results" description="Batch-wise performance across all tests — averages, pass %, and top performers." />

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className="h-11 min-w-[240px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
            <option value="">{loading ? 'Loading…' : 'Select a batch'}</option>
            {visibleBatches.map((b) => <option key={b.id} value={b.id}>{b.name}{isPrivileged ? ` — ${centreName(b.centre_id)}` : ''}</option>)}
          </select>
        </div>
      </div>

      {!batchId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch to see its performance.</Card>
      ) : loadingBatch ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : batchTests.length === 0 ? (
        <Alert type="info">No tests scheduled for this batch yet.</Alert>
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
            <div className="px-5 py-4 border-b border-neutral-100"><h4 className="font-semibold text-neutral-950">Test-by-test</h4></div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="px-5 py-2">Test</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Attempted</th><th className="px-3 py-2">Avg</th><th className="px-3 py-2">Avg %</th><th className="px-3 py-2">Pass %</th>
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {perTest.map(({ test, summary }) => (
                    <tr key={test.id} className="hover:bg-neutral-50/60">
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
