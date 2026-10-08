'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { activeBatchStudents } from '@/lib/students'
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { weeklySlotActiveOn, WEEKLY_SLOT_COLS } from '@/lib/utils'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

// ============================================================
// Student Academic Overview — one student's whole academic record in one
// place: test-by-test marks (vs the batch average, with rank), overall rank,
// and attendance (month-wise + recent class days). Everything is computed
// against the student's ASSIGNED batch (students.batch_id).
// ============================================================

type Scope = 'central' | 'branch' | 'batch-manager'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null; start_date: string; end_date: string }
type Centre = { id: string; name: string; branch_head_id: string | null }
type Student = { regno: string; student_name: string | null }
type Test = { id: string; batch_id: string; name: string; test_type: string; part_type: string; test_date: string; max_marks: number | null; pass_marks: number | null }
type Mark = { test_id: string; regno: string; marks: number | null; absent: boolean }
type Att = { regno: string; attendance_date: string; first_punch_in: string | null; last_punch_out: string | null }
type Slot = { day_of_week: number; effective_from: string | null; effective_to: string | null; batches: unknown }

const todayISO = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }
const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
const fmtMonth = (ym: string) => new Date(ym + '-01T12:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
const round1 = (n: number) => Math.round(n * 10) / 10
const pctOf = (m: Mark | undefined, max: number | null) => (m && !m.absent && m.marks != null && max ? (m.marks / max) * 100 : null)

export default function StudentOverview({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [centres, setCentres] = useState<Centre[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)

  const [centreId, setCentreId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [search, setSearch] = useState('')
  const [regno, setRegno] = useState('')

  // Per-batch data (loaded once per batch; the student view is derived).
  const [students, setStudents] = useState<Student[]>([])
  const [tests, setTests] = useState<Test[]>([])
  const [marks, setMarks] = useState<Mark[]>([])
  const [att, setAtt] = useState<Att[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [loadingBatch, setLoadingBatch] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const [cRes, bRes] = await Promise.all([
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('batches').select('id, name, centre_id, batch_manager_id, start_date, end_date').neq('status', 'Merged').order('name'),
      ])
      setCentres((cRes.data ?? []) as Centre[])
      setBatches((bRes.data ?? []) as Batch[])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Scoping (same rules as Results / Attendance) ----
  const visibleBatches = useMemo(() => {
    if (scope === 'central') return batches
    if (scope === 'batch-manager') return appUser ? batches.filter((b) => b.batch_manager_id === appUser.id) : []
    const ids = new Set<string>(getUserCentreIds(appUser))
    if (appUser) centres.filter((c) => c.branch_head_id === appUser.id).forEach((c) => ids.add(c.id))
    return batches.filter((b) => ids.has(b.centre_id))
  }, [scope, batches, centres, appUser])
  const visibleCentres = useMemo(() => {
    const ids = new Set(visibleBatches.map((b) => b.centre_id))
    return centres.filter((c) => ids.has(c.id))
  }, [centres, visibleBatches])
  useEffect(() => { if (!centreId && visibleCentres.length === 1) setCentreId(visibleCentres[0].id) }, [visibleCentres, centreId])
  const centreBatches = useMemo(() => visibleBatches.filter((b) => !centreId || b.centre_id === centreId), [visibleBatches, centreId])
  const batch = batches.find((b) => b.id === batchId) ?? null

  // ---- Load one batch ----
  useEffect(() => {
    if (!batchId || !batch) { setStudents([]); setTests([]); setMarks([]); setAtt([]); setSlots([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingBatch(true); setErr(null)
      const [sRes, ownRes, mapRes, slotRes] = await Promise.all([
        activeBatchStudents(supabase, batchId),
        supabase.from('test_schedules').select('id, batch_id, name, test_type, part_type, test_date, max_marks, pass_marks').eq('batch_id', batchId).neq('stage', 'Cancelled'),
        supabase.from('test_batch_mappings').select('test_id').eq('batch_id', batchId),
        supabase.from('batch_schedules').select(`day_of_week, ${WEEKLY_SLOT_COLS}`).eq('batch_id', batchId),
      ])
      const own = (ownRes.data ?? []) as Test[]
      const mappedIds = (mapRes.data ?? []).map((r) => r.test_id as string).filter((id) => !own.some((t) => t.id === id))
      const { data: mapped } = await fetchAllIn<Test>(mappedIds, (chunk, from, to) =>
        supabase.from('test_schedules').select('id, batch_id, name, test_type, part_type, test_date, max_marks, pass_marks').in('id', chunk).neq('stage', 'Cancelled').order('id').range(from, to))
      const allTests = [...own, ...mapped].sort((a, b) => a.test_date.localeCompare(b.test_date) || a.name.localeCompare(b.name))
      const regnos = sRes.data.map((s) => s.regno)
      const [mRes, aRes] = await Promise.all([
        fetchAllIn<Mark>(allTests.map((t) => t.id), (chunk, from, to) =>
          supabase.from('test_results').select('test_id, regno, marks, absent').in('test_id', chunk).order('test_id').order('regno').range(from, to)),
        fetchAllIn<Att>(regnos, (chunk, from, to) =>
          supabase.from('attendance').select('regno, attendance_date, first_punch_in, last_punch_out').in('regno', chunk).gte('attendance_date', batch.start_date).order('regno').order('attendance_date').range(from, to)),
      ])
      if (cancelled) return
      if (mRes.error || aRes.error || sRes.error) setErr(mRes.error ?? aRes.error ?? sRes.error)
      const inBatch = new Set(regnos)
      setStudents(sRes.data)
      setTests(allTests)
      setMarks(mRes.data.filter((m) => inBatch.has(m.regno))) // a multi-batch test holds other batches' students too
      setAtt(aRes.data)
      setSlots((slotRes.data ?? []) as Slot[])
      setLoadingBatch(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  // ---- Batch-wide derived data ----
  const markIdx = useMemo(() => {
    const m = new Map<string, Mark>()
    for (const r of marks) m.set(`${r.test_id}|${r.regno}`, r)
    return m
  }, [marks])

  // Tests that already have marks entered (the only ones that can be scored).
  const scoredTests = useMemo(() => tests.filter((t) => marks.some((m) => m.test_id === t.id && (m.absent || m.marks != null))), [tests, marks])

  // Per-test batch average % and the sorted list of %s (for ranks).
  const testStats = useMemo(() => {
    const out = new Map<string, { avg: number | null; sorted: number[] }>()
    for (const t of tests) {
      const ps = students.map((s) => pctOf(markIdx.get(`${t.id}|${s.regno}`), t.max_marks)).filter((x): x is number => x != null)
      out.set(t.id, { avg: ps.length ? round1(ps.reduce((a, b) => a + b, 0) / ps.length) : null, sorted: ps.sort((a, b) => b - a) })
    }
    return out
  }, [tests, students, markIdx])

  // Overall rank: each student's average % across the tests they attempted.
  const overallRank = useMemo(() => {
    const avgs = students.map((s) => {
      const ps = scoredTests.map((t) => pctOf(markIdx.get(`${t.id}|${s.regno}`), t.max_marks)).filter((x): x is number => x != null)
      return { regno: s.regno, avg: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null }
    }).filter((x): x is { regno: string; avg: number } => x.avg != null).sort((a, b) => b.avg - a.avg)
    return { list: avgs, batchAvg: avgs.length ? round1(avgs.reduce((a, b) => a + b.avg, 0) / avgs.length) : null }
  }, [students, scoredTests, markIdx])

  // Class days so far: every date from batch start to today (or end) with a
  // weekly slot running — but only days attendance was actually recorded for
  // this batch, so days before the sheet sync don't count as absences.
  const classDays = useMemo(() => {
    if (!batch) return [] as string[]
    const recorded = new Set(att.map((a) => a.attendance_date))
    const end = batch.end_date < todayISO() ? batch.end_date : todayISO()
    const out: string[] = []
    const d = new Date(batch.start_date + 'T12:00:00'), e = new Date(end + 'T12:00:00')
    while (d <= e) {
      const ds = d.toISOString().split('T')[0]
      if (recorded.has(ds) && slots.some((s) => s.day_of_week === d.getDay() && weeklySlotActiveOn(s, ds))) out.push(ds)
      d.setDate(d.getDate() + 1)
    }
    return out
  }, [batch, att, slots])

  const attIdx = useMemo(() => {
    const m = new Map<string, Att>()
    for (const a of att) m.set(`${a.regno}|${a.attendance_date}`, a)
    return m
  }, [att])
  const isPresent = (reg: string, date: string) => { const a = attIdx.get(`${reg}|${date}`); return !!(a && (a.first_punch_in || a.last_punch_out)) }

  const batchAttPct = useMemo(() => {
    if (!classDays.length || !students.length) return null
    let p = 0
    for (const d of classDays) for (const s of students) if (isPresent(s.regno, d)) p++
    return round1((p / (classDays.length * students.length)) * 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classDays, students, attIdx])

  // ---- The selected student ----
  const student = students.find((s) => s.regno === regno) ?? null
  const view = useMemo(() => {
    if (!student) return null
    const today = todayISO()
    const rows = tests.map((t) => {
      const m = markIdx.get(`${t.id}|${student.regno}`)
      const p = pctOf(m, t.max_marks)
      const st = testStats.get(t.id)
      const rank = p != null && st ? st.sorted.findIndex((x) => x <= p) + 1 : null
      const status = m?.absent ? 'absent' : m && m.marks != null ? 'scored' : t.test_date > today ? 'upcoming' : 'pending'
      return { t, m, p, avg: st?.avg ?? null, rank, of: st?.sorted.length ?? 0, status }
    })
    const scored = rows.filter((r) => r.p != null)
    const avg = scored.length ? round1(scored.reduce((a, r) => a + (r.p as number), 0) / scored.length) : null
    const passed = scored.filter((r) => r.t.pass_marks != null && (r.m?.marks ?? 0) >= (r.t.pass_marks as number)).length
    const withPass = scored.filter((r) => r.t.pass_marks != null).length
    const rankIdx = overallRank.list.findIndex((x) => x.regno === student.regno)

    const present = classDays.filter((d) => isPresent(student.regno, d))
    const months = new Map<string, { days: number; present: number }>()
    for (const d of classDays) {
      const k = d.slice(0, 7)
      const cur = months.get(k) ?? { days: 0, present: 0 }
      cur.days++; if (isPresent(student.regno, d)) cur.present++
      months.set(k, cur)
    }
    return {
      rows, avg, passed, withPass,
      absentTests: rows.filter((r) => r.status === 'absent').length,
      dueTests: rows.filter((r) => r.status !== 'upcoming').length,
      attempted: scored.length,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      attPct: classDays.length ? round1((present.length / classDays.length) * 100) : null,
      presentDays: present.length,
      months: Array.from(months.entries()).sort(([a], [b]) => b.localeCompare(a)),
      recent: classDays.slice(-30).map((d) => ({ d, p: isPresent(student.regno, d) })),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student, tests, markIdx, testStats, overallRank, classDays, attIdx])

  const filteredStudents = useMemo(() => {
    const q = search.toLowerCase().trim()
    return students.filter((s) => !q || (s.student_name ?? '').toLowerCase().includes(q) || s.regno.toLowerCase().includes(q))
  }, [students, search])

  const tile = 'rounded-2xl p-4 border shadow-sm'
  const sel = 'h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const tone = (p: number | null) => (p == null ? 'text-neutral-300' : p >= 75 ? 'text-emerald-600' : p >= 50 ? 'text-amber-600' : 'text-rose-600')

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Student Overview" description="One student's full academic record — test results with rank, attendance, and how they compare with the batch." />

      <div className="flex flex-wrap items-end gap-3 mb-6">
        {visibleCentres.length > 1 && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => { setCentreId(e.target.value); setBatchId(''); setRegno('') }} className={`${sel} min-w-[200px]`} disabled={loading}>
              <option value="">All centres</option>
              {visibleCentres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => { setBatchId(e.target.value); setRegno(''); setSearch('') }} className={`${sel} min-w-[240px]`} disabled={loading}>
            <option value="">{loading ? 'Loading…' : 'Select a batch'}</option>
            {centreBatches.map((b) => <option key={b.id} value={b.id}>{b.name}{!centreId ? ` — ${centres.find((c) => c.id === b.centre_id)?.name ?? ''}` : ''}</option>)}
          </select>
        </div>
      </div>

      {err && <Alert type="error">Some data could not be loaded: {err}</Alert>}

      {!batchId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch, then a student.</Card>
      ) : loadingBatch ? (
        <Card className="p-10 text-center text-neutral-400">Loading the batch…</Card>
      ) : students.length === 0 ? (
        <Alert type="info">No students are assigned to this batch yet — the Branch Head assigns them under Students.</Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          {/* Student picker */}
          <Card className="p-3 h-fit lg:sticky lg:top-4">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${students.length} students…`} className="w-full h-10 px-3 mb-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            <div className="max-h-[60vh] overflow-y-auto space-y-0.5">
              {filteredStudents.map((s) => {
                const r = overallRank.list.findIndex((x) => x.regno === s.regno)
                return (
                  <button key={s.regno} onClick={() => setRegno(s.regno)} className={`w-full text-left px-2.5 py-2 rounded-lg text-sm ${regno === s.regno ? 'bg-violet-600 text-white' : 'hover:bg-neutral-100 text-neutral-800'}`}>
                    <div className="font-medium truncate">{s.student_name || s.regno}</div>
                    <div className={`text-[11px] ${regno === s.regno ? 'text-violet-100' : 'text-neutral-400'}`}>{s.regno}{r >= 0 ? ` · Rank ${r + 1}` : ''}</div>
                  </button>
                )
              })}
              {filteredStudents.length === 0 && <p className="text-sm text-neutral-400 p-2">No match.</p>}
            </div>
          </Card>

          {!student || !view ? (
            <Card className="p-10 text-center text-neutral-400">Select a student to see their record.</Card>
          ) : (
            <div className="space-y-6 min-w-0">
              <Card className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="text-xl font-bold text-neutral-950">{student.student_name || student.regno}</h3>
                    <p className="text-sm text-neutral-500">{student.regno} · {batch?.name} · {centres.find((c) => c.id === batch?.centre_id)?.name}</p>
                  </div>
                  {batch && <p className="text-xs text-neutral-400">Batch {fmtDate(batch.start_date)} → {fmtDate(batch.end_date)}</p>}
                </div>
              </Card>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className={`${tile} border-violet-100 bg-gradient-to-br from-violet-50 to-white`}>
                  <div className="text-3xl font-black text-violet-600">{view.rank ?? '—'}<span className="text-lg text-neutral-400">{view.rank ? `/${overallRank.list.length}` : ''}</span></div>
                  <div className="text-xs font-medium text-violet-900/60 mt-1">Rank in batch</div>
                </div>
                <div className={`${tile} border-emerald-100 bg-gradient-to-br from-emerald-50 to-white`}>
                  <div className={`text-3xl font-black ${tone(view.avg)}`}>{view.avg != null ? `${view.avg}%` : '—'}</div>
                  <div className="text-xs font-medium text-emerald-900/60 mt-1">Avg score{overallRank.batchAvg != null ? ` · batch ${overallRank.batchAvg}%` : ''}</div>
                </div>
                <div className={`${tile} border-sky-100 bg-gradient-to-br from-sky-50 to-white`}>
                  <div className="text-3xl font-black text-sky-600">{view.attempted}<span className="text-lg text-neutral-400">/{view.dueTests}</span></div>
                  <div className="text-xs font-medium text-sky-900/60 mt-1">Tests attempted{view.absentTests ? ` · ${view.absentTests} absent` : ''}{view.withPass ? ` · ${view.passed} passed` : ''}</div>
                </div>
                <div className={`${tile} border-amber-100 bg-gradient-to-br from-amber-50 to-white`}>
                  <div className={`text-3xl font-black ${tone(view.attPct)}`}>{view.attPct != null ? `${view.attPct}%` : '—'}</div>
                  <div className="text-xs font-medium text-amber-900/60 mt-1">Attendance{batchAttPct != null ? ` · batch ${batchAttPct}%` : ''}</div>
                </div>
              </div>

              {/* Test history */}
              <Card className="overflow-hidden">
                <div className="px-5 py-4 border-b border-neutral-100"><h4 className="font-semibold text-neutral-950">Test history</h4></div>
                {view.rows.length === 0 ? (
                  <p className="p-5 text-sm text-neutral-400">No tests scheduled for this batch yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm min-w-[720px]">
                      <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                        <th className="px-5 py-2">Test</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Marks</th><th className="px-3 py-2 w-40">Score %</th><th className="px-3 py-2">Batch avg</th><th className="px-3 py-2">Rank</th>
                      </tr></thead>
                      <tbody className="divide-y divide-neutral-100">
                        {view.rows.map((r) => (
                          <tr key={r.t.id} className="hover:bg-neutral-50/60">
                            <td className="px-5 py-2 font-medium text-neutral-900">{r.t.name}</td>
                            <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{fmtDate(r.t.test_date)}</td>
                            <td className="px-3 py-2 text-neutral-500">{r.t.test_type} · {r.t.part_type}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {r.status === 'scored' ? <>{r.m!.marks}{r.t.max_marks ? <span className="text-neutral-400"> / {r.t.max_marks}</span> : ''}</>
                                : r.status === 'absent' ? <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-xs font-semibold">Absent</span>
                                : r.status === 'upcoming' ? <span className="text-neutral-400 text-xs">Upcoming</span>
                                : <span className="text-amber-600 text-xs">Marks not entered</span>}
                            </td>
                            <td className="px-3 py-2">
                              {r.p != null ? (
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 flex-1 rounded-full bg-neutral-100 overflow-hidden"><div className={`h-full rounded-full ${r.p >= 75 ? 'bg-emerald-500' : r.p >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(100, r.p)}%` }} /></div>
                                  <span className={`font-semibold tabular-nums ${tone(r.p)}`}>{round1(r.p)}%</span>
                                </div>
                              ) : <span className="text-neutral-300">—</span>}
                            </td>
                            <td className="px-3 py-2 text-neutral-500 tabular-nums">
                              {r.avg != null ? `${r.avg}%` : '—'}
                              {r.p != null && r.avg != null && <span className={`ml-1 text-xs ${r.p >= r.avg ? 'text-emerald-600' : 'text-rose-600'}`}>{r.p >= r.avg ? '▲' : '▼'}{round1(Math.abs(r.p - r.avg))}</span>}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{r.rank ? <>{r.rank}<span className="text-neutral-400">/{r.of}</span></> : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {/* Attendance */}
              <Card className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
                  <h4 className="font-semibold text-neutral-950">Attendance</h4>
                  <span className="text-xs text-neutral-400">{view.presentDays}/{classDays.length} class days present · counts days attendance was recorded</span>
                </div>
                {classDays.length === 0 ? (
                  <p className="text-sm text-neutral-400">No attendance recorded for this batch yet.</p>
                ) : (
                  <div className="space-y-5">
                    <div>
                      <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Last {view.recent.length} class days</div>
                      <div className="flex flex-wrap gap-1">
                        {view.recent.map(({ d, p }) => (
                          <span key={d} title={`${fmtDate(d)} — ${p ? 'Present' : 'Absent'}`} className={`grid h-7 w-7 place-items-center rounded text-[10px] font-bold ${p ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{p ? 'P' : 'A'}</span>
                        ))}
                      </div>
                    </div>
                    <table className="w-full text-left text-sm">
                      <thead><tr className="text-neutral-500 text-xs uppercase tracking-wider border-b border-neutral-100">
                        <th className="py-2">Month</th><th className="py-2">Class days</th><th className="py-2">Present</th><th className="py-2">Absent</th><th className="py-2">%</th>
                      </tr></thead>
                      <tbody className="divide-y divide-neutral-100">
                        {view.months.map(([m, v]) => {
                          const p = round1((v.present / v.days) * 100)
                          return (
                            <tr key={m}>
                              <td className="py-2 font-medium">{fmtMonth(m)}</td><td className="py-2">{v.days}</td><td className="py-2">{v.present}</td><td className="py-2">{v.days - v.present}</td>
                              <td className={`py-2 font-semibold ${tone(p)}`}>{p}%</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
