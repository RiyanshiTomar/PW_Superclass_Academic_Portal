'use client'

import { useMemo, useState } from 'react'
import { Card } from '@/components/PortalShell'
import { summarize } from '@/lib/results'
import { overallResult, passMarksFor, type PassRule, type ScoreLine } from '@/lib/passing'
import { seriesOf } from '@/lib/series'

export type TWTest = { id: string; batch_id: string; subject_id: string | null; name: string; test_type: string; part_type: string; test_date: string; max_marks: number | null; pass_marks: number | null }
export type TWResult = { test_id: string; regno: string; student_name: string | null; marks: number | null; absent: boolean }
type Student = { regno: string; student_name: string | null }

const round1 = (n: number) => Math.round(n * 10) / 10
const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const tone = (p: number | null) => (p == null ? 'text-neutral-300' : p >= 75 ? 'text-emerald-600' : p >= 50 ? 'text-amber-600' : 'text-rose-600')

type Filter = 'all' | 'attention' | 'absent' | 'top'

// One test series (e.g. every "Milestone Test 1" paper) for one batch:
// subject-wise paper stats, who is doing well, who needs attention, and each
// student's marks — the same scoring as everywhere else (absent = 0, program
// passing criteria).
export default function TestWiseResults({ tests, results, students, rule, subjectNames, batchName, initialKey }: {
  tests: TWTest[]; results: TWResult[]; students: Student[]; rule: PassRule
  subjectNames: Map<string, string>; batchName: string; initialKey?: string
}) {
  const markIdx = useMemo(() => {
    const m = new Map<string, TWResult>()
    for (const r of results) m.set(`${r.test_id}|${r.regno}`, r)
    return m
  }, [results])

  // Series of this batch that have at least one mark, newest first.
  const series = useMemo(() => {
    const withMarks = new Set(results.filter((r) => r.absent || r.marks != null).map((r) => r.test_id))
    const g = new Map<string, { key: string; label: string; tests: TWTest[] }>()
    for (const t of tests) {
      const { key, label } = seriesOf(t.name)
      const cur = g.get(key) ?? { key, label, tests: [] }
      cur.tests.push(t)
      g.set(key, cur)
    }
    return Array.from(g.values())
      .filter((s) => s.tests.some((t) => withMarks.has(t.id)))
      .map((s) => ({ ...s, tests: s.tests.sort((a, b) => a.test_date.localeCompare(b.test_date)), last: s.tests.reduce((a, t) => (t.test_date > a ? t.test_date : a), '') }))
      .sort((a, b) => b.last.localeCompare(a.last))
  }, [tests, results])

  const [key, setKey] = useState(initialKey ?? '')
  const [filter, setFilter] = useState<Filter>('all')
  const current = series.find((s) => s.key === key) ?? series[0]

  const paperName = (t: TWTest, all: TWTest[]) => {
    const base = t.subject_id ? subjectNames.get(t.subject_id) ?? 'Subject' : t.part_type === 'Full' ? 'Full syllabus' : t.name
    const dup = all.filter((x) => (x.subject_id ? subjectNames.get(x.subject_id) ?? 'Subject' : x.part_type === 'Full' ? 'Full syllabus' : x.name) === base).length > 1
    return dup ? `${base} (${fmtDate(t.test_date)})` : base
  }

  const view = useMemo(() => {
    if (!current) return null
    const papers = current.tests.map((t) => {
      const rows = students.map((s) => markIdx.get(`${t.id}|${s.regno}`)).filter((x): x is TWResult => !!x)
      const sum = summarize(rows.map((r) => ({ ...r, student_name: r.student_name ?? '', source: '' })), t.max_marks, passMarksFor(t, rule))
      const best = rows.filter((r) => !r.absent && r.marks != null).sort((a, b) => (b.marks as number) - (a.marks as number))[0]
      const bestName = best ? students.find((s) => s.regno === best.regno)?.student_name || best.regno : null
      return { t, name: paperName(t, current.tests), sum, bestName, notEntered: students.length - sum.entered }
    })
    const list = students.map((s) => {
      const cells = current.tests.map((t) => markIdx.get(`${t.id}|${s.regno}`))
      const lines: ScoreLine[] = current.tests.flatMap((t, i) => {
        const m = cells[i]
        if (!t.max_marks || !m || (!m.absent && m.marks == null)) return []
        return [{ subjectId: t.subject_id, obtained: m.absent ? 0 : (m.marks as number), max: t.max_marks }]
      })
      const res = overallResult(lines, rule, (id) => subjectNames.get(id) ?? 'Subject')
      const entered = cells.filter((m) => m && (m.absent || m.marks != null)).length
      const absent = cells.filter((m) => m?.absent).length
      const attempted = entered - absent
      return {
        regno: s.regno, name: s.student_name || s.regno, cells, res, entered, absent, attempted,
        obtained: round1(lines.reduce((a, l) => a + l.obtained, 0)), max: lines.reduce((a, l) => a + l.max, 0),
      }
    })
    const ranked = list.filter((x) => x.attempted > 0 && x.res.aggregate != null).sort((a, b) => (b.res.aggregate as number) - (a.res.aggregate as number))
    const rankOf = new Map(ranked.map((x, i) => [x.regno, i + 1]))
    const appeared = list.filter((x) => x.attempted > 0).length
    const allAbsent = list.filter((x) => x.entered > 0 && x.attempted === 0)
    const noRecord = list.filter((x) => x.entered === 0).length
    const failing = list.filter((x) => x.attempted > 0 && x.res.status === 'Fail')
    const passing = list.filter((x) => x.attempted > 0 && x.res.status === 'Pass').length
    const avg = ranked.length ? round1(ranked.reduce((a, x) => a + (x.res.aggregate as number), 0) / ranked.length) : null
    return { papers, list, ranked, rankOf, appeared, allAbsent, noRecord, failing, passing, avg }
  }, [current, students, markIdx, rule, subjectNames]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!series.length) return <Card className="p-10 text-center text-neutral-400">No test of this batch has marks entered yet.</Card>
  if (!current || !view) return null

  const rows = (() => {
    const sorted = [...view.list].sort((a, b) => (view.rankOf.get(a.regno) ?? 1e9) - (view.rankOf.get(b.regno) ?? 1e9) || a.name.localeCompare(b.name))
    if (filter === 'attention') return sorted.filter((x) => (x.attempted > 0 && x.res.status === 'Fail') || (x.entered > 0 && x.attempted === 0) || x.absent > 0)
    if (filter === 'absent') return sorted.filter((x) => x.absent > 0)
    if (filter === 'top') return sorted.filter((x) => (view.rankOf.get(x.regno) ?? 1e9) <= 10)
    return sorted
  })()

  const downloadCsv = () => {
    const cell = (v: string | number | null | undefined) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const head = ['Rank', 'Student ID', 'Student', ...view.papers.map((p) => `${p.name} /${p.t.max_marks ?? ''}`), 'Total', 'Max', 'Score % (absent = 0)', 'Result', 'Below the mark']
    const body = [...view.list].sort((a, b) => (view.rankOf.get(a.regno) ?? 1e9) - (view.rankOf.get(b.regno) ?? 1e9)).map((x) => [
      view.rankOf.get(x.regno) ?? '', x.regno, x.name,
      ...x.cells.map((m) => (m?.absent ? 'AB' : m?.marks ?? '')),
      x.max ? x.obtained : '', x.max || '', x.res.aggregate ?? '', x.attempted ? x.res.status ?? '' : x.entered ? 'Absent' : 'Not entered', x.res.reasons.join('; '),
    ])
    const paperRows = [[], ['SUBJECT-WISE'], ['Paper', 'Date', 'Appeared', 'Absent', 'Not entered', 'Avg %', 'Highest', 'Lowest', 'Pass %', 'Topper'],
      ...view.papers.map((p) => [p.name, p.t.test_date, p.sum.attempted, p.sum.absent, p.notEntered, p.sum.avgPct ?? '', p.sum.highest ?? '', p.sum.lowest ?? '', p.sum.passPct ?? '', p.bestName ?? ''])]
    const lines = [[`${batchName} — ${current.label}`], ['Criteria', rule.label], [], head, ...body, ...paperRows]
    const blob = new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${batchName} - ${current.label}.csv`; a.click()
    URL.revokeObjectURL(a.href)
  }

  const tile = 'rounded-2xl p-4 border shadow-sm'
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Test</label>
          <select value={current.key} onChange={(e) => { setKey(e.target.value); setFilter('all') }} className="h-11 min-w-[260px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
            {series.map((s) => <option key={s.key} value={s.key}>{s.label} — {s.tests.length} paper{s.tests.length === 1 ? '' : 's'} · {fmtDate(s.last)}</option>)}
          </select>
        </div>
        <button onClick={downloadCsv} className="h-11 px-4 rounded-xl border border-neutral-200 bg-white text-sm font-semibold text-neutral-700 hover:bg-neutral-50">⬇ Download CSV</button>
        <span className="text-xs text-neutral-400 pb-3">Criteria: {rule.label} · absent = 0</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className={`${tile} border-sky-100 bg-gradient-to-br from-sky-50 to-white`}><div className="text-3xl font-black text-sky-600">{view.appeared}<span className="text-lg text-neutral-400">/{students.length}</span></div><div className="text-xs font-medium text-sky-900/60 mt-1">Appeared</div></div>
        <div className={`${tile} border-rose-100 bg-gradient-to-br from-rose-50 to-white`}><div className="text-3xl font-black text-rose-600">{view.allAbsent.length}</div><div className="text-xs font-medium text-rose-900/60 mt-1">Absent{view.noRecord ? ` · ${view.noRecord} not entered` : ''}</div></div>
        <div className={`${tile} border-violet-100 bg-gradient-to-br from-violet-50 to-white`}><div className={`text-3xl font-black ${tone(view.avg)}`}>{view.avg != null ? `${view.avg}%` : '—'}</div><div className="text-xs font-medium text-violet-900/60 mt-1">Batch average</div></div>
        <div className={`${tile} border-emerald-100 bg-gradient-to-br from-emerald-50 to-white`}><div className="text-3xl font-black text-emerald-600">{view.passing}</div><div className="text-xs font-medium text-emerald-900/60 mt-1">Passed</div></div>
        <div className={`${tile} border-amber-100 bg-gradient-to-br from-amber-50 to-white`}><div className="text-3xl font-black text-amber-600">{view.failing.length}</div><div className="text-xs font-medium text-amber-900/60 mt-1">Failed</div></div>
      </div>

      {/* Subject-wise */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100"><h4 className="font-semibold text-neutral-950">Subject-wise</h4></div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[760px]">
            <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
              <th className="px-5 py-2">Paper</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Appeared</th><th className="px-3 py-2">Avg %</th>
              <th className="px-3 py-2">Highest</th><th className="px-3 py-2">Lowest</th><th className="px-3 py-2">Pass %</th><th className="px-3 py-2">Topper</th>
            </tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {view.papers.map((p) => (
                <tr key={p.t.id}>
                  <td className="px-5 py-2 font-medium text-neutral-900">{p.name}<div className="text-xs font-normal text-neutral-400">{p.t.test_type} · {p.t.part_type}{p.t.max_marks ? ` · /${p.t.max_marks}` : ''}</div></td>
                  <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{fmtDate(p.t.test_date)}</td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">{p.sum.attempted}{p.sum.absent ? <span className="text-rose-600"> · {p.sum.absent} AB</span> : ''}{p.notEntered ? <span className="text-amber-600"> · {p.notEntered} not entered</span> : ''}</td>
                  <td className={`px-3 py-2 font-semibold tabular-nums ${tone(p.sum.avgPct)}`}>{p.sum.avgPct != null ? `${p.sum.avgPct}%` : '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.sum.highest ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.sum.lowest ?? '—'}</td>
                  <td className={`px-3 py-2 font-semibold tabular-nums ${p.sum.passPct == null ? 'text-neutral-300' : p.sum.passPct >= 60 ? 'text-emerald-600' : 'text-amber-600'}`}>{p.sum.passPct != null ? `${p.sum.passPct}%` : '—'}</td>
                  <td className="px-3 py-2 text-neutral-700">{p.bestName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Doing well / needs attention */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <h4 className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-3">Doing well</h4>
          {view.ranked.length === 0 ? <p className="text-sm text-neutral-400">No marks yet.</p> : (
            <ol className="space-y-1.5 text-sm">
              {view.ranked.slice(0, 5).map((x, i) => (
                <li key={x.regno} className="flex justify-between gap-3"><span><span className="text-neutral-400 tabular-nums mr-2">{i + 1}.</span>{x.name}</span><span className="font-semibold text-emerald-600 tabular-nums">{x.res.aggregate}%</span></li>
              ))}
            </ol>
          )}
        </Card>
        <Card className="p-5">
          <h4 className="text-xs font-bold text-rose-700 uppercase tracking-wider mb-3">Needs attention ({view.failing.length + view.allAbsent.length})</h4>
          {view.failing.length + view.allAbsent.length === 0 ? <p className="text-sm text-neutral-400">Everyone who appeared passed. 🎉</p> : (
            <ul className="space-y-1.5 text-sm max-h-60 overflow-y-auto pr-1">
              {[...view.failing].sort((a, b) => (a.res.aggregate ?? 0) - (b.res.aggregate ?? 0)).map((x) => (
                <li key={x.regno}>
                  <div className="flex justify-between gap-3"><span>{x.name}</span><span className="font-semibold text-rose-600 tabular-nums">{x.res.aggregate}%</span></div>
                  {x.res.reasons.length > 0 && <div className="text-xs text-neutral-500">{x.res.reasons.join('; ')}</div>}
                </li>
              ))}
              {view.allAbsent.map((x) => (
                <li key={x.regno} className="flex justify-between gap-3"><span>{x.name}</span><span className="text-xs font-semibold text-rose-600">Absent</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Every student */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold text-neutral-950">Students ({rows.length})</h4>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {([['all', 'All'], ['top', 'Top 10'], ['attention', 'Needs attention'], ['absent', 'Absent in a paper']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setFilter(k)} className={`px-2.5 py-1 rounded-lg border ${filter === k ? 'bg-violet-600 border-violet-600 text-white' : 'border-neutral-200 text-neutral-600 hover:bg-violet-50'}`}>{t}</button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
              <th className="px-5 py-2">Rank</th><th className="px-3 py-2">Student</th>
              {view.papers.map((p) => <th key={p.t.id} className="px-3 py-2 whitespace-nowrap">{p.name}{p.t.max_marks ? <span className="normal-case text-neutral-400"> /{p.t.max_marks}</span> : ''}</th>)}
              <th className="px-3 py-2">Total</th><th className="px-3 py-2">%</th><th className="px-3 py-2">Result</th>
            </tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((x) => (
                <tr key={x.regno} className={x.attempted > 0 && x.res.status === 'Fail' ? 'bg-rose-50/40' : ''}>
                  <td className="px-5 py-2 tabular-nums text-neutral-500">{view.rankOf.get(x.regno) ?? '—'}</td>
                  <td className="px-3 py-2"><div className="font-medium text-neutral-900">{x.name}</div><div className="text-xs text-neutral-400">{x.regno}</div></td>
                  {x.cells.map((m, i) => {
                    const t = current.tests[i]
                    const pm = passMarksFor(t, rule)
                    return (
                      <td key={t.id} className="px-3 py-2 tabular-nums whitespace-nowrap">
                        {m?.absent ? <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-xs font-semibold">AB</span>
                          : m?.marks != null ? <span className={pm != null && m.marks < pm ? 'text-rose-600 font-semibold' : ''}>{m.marks}</span>
                          : <span className="text-neutral-300">—</span>}
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">{x.max ? <>{x.obtained}<span className="text-neutral-400"> / {x.max}</span></> : '—'}</td>
                  <td className={`px-3 py-2 font-semibold tabular-nums ${tone(x.attempted ? x.res.aggregate : null)}`}>{x.attempted && x.res.aggregate != null ? `${x.res.aggregate}%` : '—'}</td>
                  <td className="px-3 py-2">
                    {x.attempted === 0 ? (x.entered ? <span className="text-xs font-semibold text-rose-600">Absent</span> : <span className="text-xs text-amber-600">Not entered</span>)
                      : x.res.status === 'Pass' ? <span className="text-xs font-semibold text-emerald-600">Pass</span>
                      : <span className="text-xs font-semibold text-red-600" title={x.res.reasons.join('; ')}>Fail</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-xs text-neutral-400 border-t border-neutral-100">Red marks are below that paper&apos;s pass mark. Rank is within this test only; the overall rank (all tests) is in Student Overview.</p>
      </Card>
    </div>
  )
}
