'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { activeBatchStudents } from '@/lib/students'
import { fetchAllIn } from '@/lib/supabase/fetch-all'
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
  // One student's record. Only tests held till today — upcoming ones are not
  // part of a marksheet.
  const buildView = (student: Student) => {
    const today = todayISO()
    const rows = tests.filter((t) => t.test_date <= today).map((t) => {
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
  }
  const view = useMemo(() => (student ? buildView(student) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [student, tests, markIdx, testStats, overallRank, classDays, attIdx])

  // ---- Downloads (CSV — opens in Excel / Google Sheets) ----
  const cell = (v: string | number | null | undefined) => {
    const t = v == null ? '' : String(v)
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const saveCsv = (name: string, lines: (string | number | null | undefined)[][]) => {
    // BOM so Excel reads Hindi / special characters correctly.
    const blob = new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name.replace(/[\\/:*?"<>|]+/g, '-'); a.click()
    URL.revokeObjectURL(url)
  }
  const centreName = centres.find((c) => c.id === batch?.centre_id)?.name ?? ''

  // Printable marksheet (A4) for any student of the batch — opens in a new
  // tab with the print dialog; "Save as PDF" gives a file to share.
  const esc = (v: string | number | null | undefined) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const openMarksheet = (s: Student) => {
    if (!batch) return
    const v = buildView(s)
    const w = window.open('', '_blank')
    if (!w) { setErr('Allow pop-ups for this site to download the marksheet.'); return }
    const resultOf = (r: (typeof v.rows)[number]) =>
      r.status === 'absent' ? '<span class="ab">Absent</span>'
        : r.status !== 'scored' ? '<span class="na">Marks not entered</span>'
          : r.t.pass_marks != null ? ((r.m!.marks ?? 0) >= r.t.pass_marks ? '<span class="ok">Pass</span>' : '<span class="ab">Fail</span>') : '—'
    const testRows = v.rows.map((r) => `<tr>
      <td>${esc(r.t.name)}</td><td>${esc(fmtDate(r.t.test_date))}</td><td>${esc(r.t.test_type)} · ${esc(r.t.part_type)}</td>
      <td class="n">${r.status === 'scored' ? `${esc(r.m!.marks)}${r.t.max_marks ? ` / ${esc(r.t.max_marks)}` : ''}` : '—'}</td>
      <td class="n">${r.p != null ? `${round1(r.p)}%` : '—'}</td>
      <td class="n">${r.avg != null ? `${r.avg}%` : '—'}</td>
      <td class="n">${r.rank ? `${r.rank}/${r.of}` : '—'}</td>
      <td>${resultOf(r)}</td></tr>`).join('')
    const monthRows = v.months.map(([m, x]) => `<tr><td>${esc(fmtMonth(m))}</td><td class="n">${x.days}</td><td class="n">${x.present}</td><td class="n">${x.days - x.present}</td><td class="n">${round1((x.present / x.days) * 100)}%</td></tr>`).join('')
    const title = `Marksheet - ${s.student_name || s.regno} - ${s.regno}`
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; margin: 0; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 8px; }
  .muted { color: #666; } .info { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; margin-top: 10px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
  .kpi { border: 1px solid #ccc; border-radius: 6px; padding: 8px; } .kpi b { display: block; font-size: 17px; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 5px 6px; text-align: left; }
  th { background: #f2f2f2; font-size: 11px; } td.n { text-align: right; white-space: nowrap; }
  .ok { color: #0a7a3b; font-weight: bold; } .ab { color: #b42318; font-weight: bold; } .na { color: #888; }
  .foot { margin-top: 18px; font-size: 10px; color: #777; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="noprint" style="padding:8px 0 12px"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="head"><div><h1>Student Marksheet</h1><div class="muted">${esc(centreName)}</div></div><div class="muted">Till ${esc(fmtDate(todayISO()))}</div></div>
<div class="info">
  <div><b>Name:</b> ${esc(s.student_name || '—')}</div><div><b>Student ID:</b> ${esc(s.regno)}</div>
  <div><b>Batch:</b> ${esc(batch.name)}</div><div><b>Batch dates:</b> ${esc(fmtDate(batch.start_date))} – ${esc(fmtDate(batch.end_date))}</div>
</div>
<div class="kpis">
  <div class="kpi"><span class="muted">Rank in batch</span><b>${v.rank ? `${v.rank} / ${overallRank.list.length}` : '—'}</b></div>
  <div class="kpi"><span class="muted">Average score</span><b>${v.avg != null ? `${v.avg}%` : '—'}</b><span class="muted">Batch ${overallRank.batchAvg ?? '—'}%</span></div>
  <div class="kpi"><span class="muted">Tests attempted</span><b>${v.attempted} / ${v.dueTests}</b><span class="muted">${v.absentTests} absent</span></div>
  <div class="kpi"><span class="muted">Attendance</span><b>${v.attPct != null ? `${v.attPct}%` : '—'}</b><span class="muted">${v.presentDays} / ${classDays.length} days</span></div>
</div>
<h2>Test results</h2>
${v.rows.length ? `<table><thead><tr><th>Test</th><th>Date</th><th>Type</th><th>Marks</th><th>Score</th><th>Batch avg</th><th>Rank</th><th>Result</th></tr></thead><tbody>${testRows}</tbody></table>` : '<p class="muted">No tests held yet.</p>'}
<h2>Attendance</h2>
${v.months.length ? `<table><thead><tr><th>Month</th><th>Class days</th><th>Present</th><th>Absent</th><th>Attendance</th></tr></thead><tbody>${monthRows}</tbody></table>` : '<p class="muted">No attendance recorded yet.</p>'}
<div class="foot">Generated on ${esc(new Date().toLocaleString('en-IN'))} · Includes tests held till today only.</div>
<script>window.onload = () => setTimeout(() => window.print(), 300)</script>
</body></html>`)
    w.document.close()
  }

  // One student's full record: summary, every test, month-wise attendance.
  const downloadStudent = () => {
    if (!student || !view || !batch) return
    const lines: (string | number | null)[][] = [
      ['Student', student.student_name || ''], ['Student ID', student.regno], ['Batch', batch.name], ['Centre', centreName],
      ['Batch dates', `${batch.start_date} to ${batch.end_date}`],
      ['Rank in batch', view.rank ? `${view.rank} / ${overallRank.list.length}` : '—'],
      ['Average score %', view.avg ?? '—'], ['Batch average %', overallRank.batchAvg ?? '—'],
      ['Tests attempted', `${view.attempted} / ${view.dueTests}`], ['Tests absent', view.absentTests],
      ['Attendance %', view.attPct ?? '—'], ['Batch attendance %', batchAttPct ?? '—'],
      ['Class days present', `${view.presentDays} / ${classDays.length}`],
      [],
      ['TEST HISTORY'],
      ['Test', 'Date', 'Type', 'Scope', 'Marks', 'Max marks', 'Score %', 'Batch avg %', 'Rank', 'Status'],
      ...view.rows.map((r) => [
        r.t.name, r.t.test_date, r.t.test_type, r.t.part_type,
        r.status === 'scored' ? r.m!.marks : r.status === 'absent' ? 'Absent' : '',
        r.t.max_marks, r.p != null ? round1(r.p) : '', r.avg ?? '', r.rank ? `${r.rank}/${r.of}` : '',
        r.status === 'scored' ? 'Scored' : r.status === 'absent' ? 'Absent' : r.status === 'upcoming' ? 'Upcoming' : 'Marks not entered',
      ]),
      [],
      ['ATTENDANCE BY MONTH'],
      ['Month', 'Class days', 'Present', 'Absent', 'Attendance %'],
      ...view.months.map(([m, v]) => [fmtMonth(m), v.days, v.present, v.days - v.present, round1((v.present / v.days) * 100)]),
      [],
      ['ATTENDANCE BY DAY'],
      ['Date', 'Status'],
      ...classDays.slice().reverse().map((d) => [d, isPresent(student.regno, d) ? 'Present' : 'Absent']),
    ]
    saveCsv(`${student.student_name || student.regno} - ${student.regno} - ${batch.name}.csv`, lines)
  }

  // Every student of the batch on one sheet.
  const downloadBatch = () => {
    if (!batch) return
    const header = ['Student ID', 'Student', 'Rank', 'Average score %', 'Tests attempted', 'Tests absent', 'Attendance %',
      ...scoredTests.map((t) => `${t.name} (${t.test_date}) /${t.max_marks ?? ''}`)]
    const lines = students.map((s) => {
      const ps = scoredTests.map((t) => markIdx.get(`${t.id}|${s.regno}`))
      const pcts = scoredTests.map((t) => pctOf(markIdx.get(`${t.id}|${s.regno}`), t.max_marks)).filter((x): x is number => x != null)
      const rank = overallRank.list.findIndex((x) => x.regno === s.regno)
      const present = classDays.filter((d) => isPresent(s.regno, d)).length
      return [
        s.regno, s.student_name || '', rank >= 0 ? rank + 1 : '',
        pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : '',
        pcts.length, ps.filter((m) => m?.absent).length,
        classDays.length ? round1((present / classDays.length) * 100) : '',
        ...ps.map((m) => (m?.absent ? 'AB' : m?.marks ?? '')),
      ]
    })
    saveCsv(`${batch.name} - ${centreName} - students.csv`, [header, ...lines])
  }

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
            <button onClick={downloadBatch} className="w-full h-9 mb-2 rounded-lg text-xs font-semibold border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100">⬇ Download batch ({students.length} students)</button>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${students.length} students…`} className="w-full h-10 px-3 mb-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            <div className="max-h-[60vh] overflow-y-auto space-y-0.5">
              {filteredStudents.map((s) => {
                const r = overallRank.list.findIndex((x) => x.regno === s.regno)
                return (
                  <div key={s.regno} className={`flex items-center gap-1 rounded-lg ${regno === s.regno ? 'bg-violet-600 text-white' : 'hover:bg-neutral-100 text-neutral-800'}`}>
                    <button onClick={() => setRegno(s.regno)} className="flex-1 min-w-0 text-left px-2.5 py-2 text-sm">
                      <div className="font-medium truncate">{s.student_name || s.regno}</div>
                      <div className={`text-[11px] ${regno === s.regno ? 'text-violet-100' : 'text-neutral-400'}`}>{s.regno}{r >= 0 ? ` · Rank ${r + 1}` : ''}</div>
                    </button>
                    <button onClick={() => openMarksheet(s)} title="Download marksheet (PDF)" className={`shrink-0 mr-1.5 h-7 w-7 grid place-items-center rounded-md text-xs ${regno === s.regno ? 'hover:bg-violet-500' : 'text-violet-600 hover:bg-violet-100'}`}>⬇</button>
                  </div>
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
                  <div className="text-right">
                    {batch && <p className="text-xs text-neutral-400">Batch {fmtDate(batch.start_date)} → {fmtDate(batch.end_date)}</p>}
                    <div className="mt-2 flex justify-end gap-2">
                      <button onClick={() => openMarksheet(student)} className="h-9 px-3 rounded-lg text-sm font-semibold bg-violet-600 text-white hover:bg-violet-700">⬇ Marksheet (PDF)</button>
                      <button onClick={downloadStudent} className="h-9 px-3 rounded-lg text-sm font-semibold border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100">Excel</button>
                    </div>
                  </div>
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
