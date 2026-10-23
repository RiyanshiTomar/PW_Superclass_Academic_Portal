'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Usage = { facultyId: string; batchId: string; subjectId: string | null; centreId: string | null; lectures: number; taughtMin: number; upcomingMin: number; upcomingLectures: number }
type Weekly = { facultyId: string; centreId: string; subjectId: string | null; min: number }
type Data = {
  from: string; to: string; today: string
  centres: { id: string; name: string }[]; subjects: { id: string; name: string }[]
  batches: { id: string; name: string; centreId: string }[]
  faculty: { id: string; name: string; centreIds: string[] }[]
  usage: Usage[]; weekly: Weekly[]
}
type Row = { id: string; name: string; hours: number; upcoming: number; lectures: number; weeklyHrs: number; subjects: string[]; branches: string[]; batches: number }

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const shift = (d: string, n: number) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10) }
const monthStart = (d: string) => d.slice(0, 8) + '01'
const prevMonth = (d: string) => { const x = new Date(monthStart(d) + 'T12:00:00'); x.setMonth(x.getMonth() - 1); const f = x.toISOString().slice(0, 10); return [f, shift(monthStart(d), -1)] as const }
const h1 = (min: number) => Math.round((min / 60) * 10) / 10
const field = 'h-9 px-3 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-400'
const label = 'block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1'

export default function HeadFacultyUsage() {
  const today = istToday()
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [centre, setCentre] = useState<string | null>(null)
  const [subject, setSubject] = useState('')

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/head/faculty?from=${f}&to=${t}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Could not load.')
      setData(j)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.') }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(from, to) }, [])
  const pick = (f: string, t: string) => { setFrom(f); setTo(t); load(f, t) }

  const centreName = useMemo(() => new Map((data?.centres ?? []).map((c) => [c.id, c.name])), [data])
  const subjName = useMemo(() => new Map((data?.subjects ?? []).map((s) => [s.id, s.name])), [data])

  // Faculty figures for a branch (null = whole Superclass) and subject filter.
  const rowsFor = useCallback((c: string | null, subj: string): Row[] => {
    if (!data) return []
    const u = data.usage.filter((x) => (!c || x.centreId === c) && (!subj || x.subjectId === subj))
    const w = data.weekly.filter((x) => (!c || x.centreId === c) && (!subj || x.subjectId === subj))
    const pool = data.faculty.filter((f) =>
      subj ? u.some((x) => x.facultyId === f.id) || w.some((x) => x.facultyId === f.id)
        : !c || f.centreIds.includes(c) || u.some((x) => x.facultyId === f.id) || w.some((x) => x.facultyId === f.id))
    return pool.map((f) => {
      const mine = u.filter((x) => x.facultyId === f.id)
      const myW = w.filter((x) => x.facultyId === f.id)
      const subjects = new Set([...mine, ...myW].map((x) => x.subjectId).filter((x): x is string => !!x).map((id) => subjName.get(id) ?? 'Subject'))
      const branches = new Set([...mine.map((x) => x.centreId), ...myW.map((x) => x.centreId)].filter((x): x is string => !!x).map((id) => centreName.get(id) ?? '—'))
      return {
        id: f.id, name: f.name,
        hours: h1(mine.reduce((a, x) => a + x.taughtMin, 0)), upcoming: h1(mine.reduce((a, x) => a + x.upcomingMin, 0)),
        lectures: mine.reduce((a, x) => a + x.lectures, 0), weeklyHrs: h1(myW.reduce((a, x) => a + x.min, 0)),
        subjects: Array.from(subjects).sort(), branches: Array.from(branches).sort(), batches: new Set(mine.map((x) => x.batchId)).size,
      }
    }).sort((a, b) => b.hours - a.hours || b.weeklyHrs - a.weeklyHrs || a.name.localeCompare(b.name))
  }, [data, subjName, centreName])

  const rows = useMemo(() => rowsFor(centre, subject), [rowsFor, centre, subject])
  const stats = (rs: Row[]) => {
    const total = Math.round(rs.reduce((a, r) => a + r.hours, 0) * 10) / 10
    const sorted = [...rs].sort((a, b) => b.hours - a.hours)
    return { count: rs.length, total, avg: rs.length ? Math.round((total / rs.length) * 10) / 10 : null, idle: rs.filter((r) => r.hours === 0).length, most: sorted[0], least: sorted[sorted.length - 1] }
  }
  const top = stats(rows)
  const maxHrs = Math.max(1, ...rows.map((r) => r.hours))

  const branchRows = useMemo(() => (data?.centres ?? []).map((c) => ({ c, s: stats(rowsFor(c.id, subject)) })).filter((x) => x.s.count > 0)
    .sort((a, b) => a.c.name.localeCompare(b.c.name)), [data, rowsFor, subject])  
  const subjectRows = useMemo(() => {
    if (!data) return []
    const ids = new Set(data.usage.filter((x) => !centre || x.centreId === centre).map((x) => x.subjectId).filter((x): x is string => !!x))
    return Array.from(ids).map((id) => ({ id, name: subjName.get(id) ?? 'Subject', s: stats(rowsFor(centre, id)) })).sort((a, b) => b.s.total - a.s.total)
  }, [data, centre, rowsFor, subjName])  

  const usedName = (r?: Row) => (r ? `${r.name} (${r.hours}h)` : '—')
  const presets: [string, string, string][] = [
    ['This month', monthStart(today), today], ['Last month', ...prevMonth(today)], ['Last 30 days', shift(today, -29), today], ['Last 90 days', shift(today, -89), today],
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Faculty Usage" description="Hours each faculty is teaching — whole Superclass, each branch, subject-wise. Most and least used at a glance." />
      {err && <Alert type="error">{err}</Alert>}

      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div><label className={label}>From</label><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={field} /></div>
          <div><label className={label}>To</label><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={field} /></div>
          <button onClick={() => load(from, to)} disabled={loading || from > to} className="h-9 px-4 rounded-lg bg-violet-600 text-white text-sm font-semibold disabled:opacity-50">{loading ? 'Loading…' : 'Apply'}</button>
          <div>
            <label className={label}>Branch</label>
            <select value={centre ?? ''} onChange={(e) => setCentre(e.target.value || null)} className={`${field} min-w-[170px]`}>
              <option value="">Whole Superclass</option>
              {(data?.centres ?? []).filter((c) => branchRows.some((b) => b.c.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Subject</label>
            <select value={subject} onChange={(e) => setSubject(e.target.value)} className={`${field} min-w-[170px]`}>
              <option value="">All subjects</option>
              {subjectRows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3 text-xs">
          {presets.map(([t, f, tt]) => (
            <button key={t} onClick={() => pick(f, tt)} className={`px-2.5 py-1 rounded-lg border ${from === f && to === tt ? 'bg-violet-600 border-violet-600 text-white' : 'border-neutral-200 text-neutral-600 hover:bg-violet-50'}`}>{t}</button>
          ))}
        </div>
      </Card>

      {data && (
        <>
          <div className="text-sm">
            <button onClick={() => setCentre(null)} className={centre ? 'text-violet-600 hover:underline font-semibold' : 'font-bold text-neutral-900'}>Superclass</button>
            {centre && <> <span className="text-neutral-400">›</span> <span className="font-bold text-neutral-900">{centreName.get(centre)}</span></>}
            {subject && <> <span className="text-neutral-400">›</span> <span className="font-bold text-neutral-900">{subjName.get(subject)}</span></>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { k: 'Faculty', v: top.count, s: '' },
              { k: 'Hours taught', v: top.total, s: `${data.from} → ${data.to < data.today ? data.to : data.today}` },
              { k: 'Avg per faculty', v: top.avg != null ? `${top.avg} h` : '—', s: 'hours taught' },
              { k: 'Most used', v: top.most?.hours ? `${top.most.hours} h` : '—', s: top.most?.hours ? top.most.name : '' },
              { k: 'Not teaching', v: top.idle, s: '0 hours in this period' },
            ].map((t) => (
              <Card key={t.k} className="p-4">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{t.k}</div>
                <div className="text-2xl font-black text-neutral-950 mt-1 tabular-nums">{t.v}</div>
                {t.s && <div className="text-xs text-neutral-400 mt-0.5 truncate">{t.s}</div>}
              </Card>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {!centre && (
              <Card className="overflow-hidden p-0">
                <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between"><span className="font-semibold text-neutral-950">Branches</span><span className="text-xs text-neutral-400">Click to drill down</span></div>
                <table className="w-full text-sm">
                  <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left"><th className="px-5 py-2">Branch</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Hours</th><th className="px-3 py-2">Avg</th><th className="px-3 py-2">Most / least used</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {branchRows.map(({ c, s }) => (
                      <tr key={c.id} onClick={() => setCentre(c.id)} className="cursor-pointer hover:bg-violet-50/50 align-top">
                        <td className="px-5 py-2 font-semibold text-violet-700">{c.name} ›</td>
                        <td className="px-3 py-2 tabular-nums">{s.count}</td>
                        <td className="px-3 py-2 tabular-nums">{s.total}</td>
                        <td className="px-3 py-2 tabular-nums">{s.avg ?? '—'}</td>
                        <td className="px-3 py-2 text-xs"><div className="text-emerald-700">▲ {usedName(s.most)}</div><div className="text-rose-600">▼ {usedName(s.least)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            <Card className={`overflow-hidden p-0 ${centre ? 'lg:col-span-2' : ''}`}>
              <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between"><span className="font-semibold text-neutral-950">Subject-wise</span><span className="text-xs text-neutral-400">Click to filter</span></div>
              <table className="w-full text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left"><th className="px-5 py-2">Subject</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Hours</th><th className="px-3 py-2">Most / least used</th></tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {subjectRows.map(({ id, name, s }) => (
                    <tr key={id} onClick={() => setSubject(subject === id ? '' : id)} className={`cursor-pointer hover:bg-violet-50/50 align-top ${subject === id ? 'bg-violet-50' : ''}`}>
                      <td className="px-5 py-2 font-medium text-neutral-900">{name}</td>
                      <td className="px-3 py-2 tabular-nums">{s.count}</td>
                      <td className="px-3 py-2 tabular-nums">{s.total}</td>
                      <td className="px-3 py-2 text-xs"><div className="text-emerald-700">▲ {usedName(s.most)}</div>{s.count > 1 && <div className="text-rose-600">▼ {usedName(s.least)}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <Card className="overflow-hidden p-0">
            <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between"><span className="font-semibold text-neutral-950">Faculty ({rows.length})</span><span className="text-xs text-neutral-400">Most used first</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                  <th className="px-5 py-2">Faculty</th><th className="px-3 py-2 w-56">Hours taught</th><th className="px-3 py-2">Lectures</th><th className="px-3 py-2">Still planned</th>
                  <th className="px-3 py-2">Weekly hrs now</th><th className="px-3 py-2">Batches</th><th className="px-3 py-2">Subjects</th>{!centre && <th className="px-3 py-2">Branches</th>}
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((r, i) => (
                    <tr key={r.id} className={r.hours === 0 ? 'bg-rose-50/40' : ''}>
                      <td className="px-5 py-2 font-medium text-neutral-900">{r.name}{i < 3 && r.hours > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">top</span>}{r.hours === 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">not teaching</span>}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-neutral-100 overflow-hidden"><div className="h-full rounded-full bg-violet-500" style={{ width: `${(r.hours / maxHrs) * 100}%` }} /></div>
                          <span className="font-semibold tabular-nums w-12 text-right">{r.hours} h</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{r.lectures}</td>
                      <td className="px-3 py-2 tabular-nums text-neutral-500">{r.upcoming ? `${r.upcoming} h` : '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{r.weeklyHrs || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{r.batches || '—'}</td>
                      <td className="px-3 py-2 text-xs text-neutral-600">{r.subjects.join(', ') || '—'}</td>
                      {!centre && <td className="px-3 py-2 text-xs text-neutral-600">{r.branches.join(', ') || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-3 text-xs text-neutral-400 border-t border-neutral-100">
              Hours taught = planner lectures dated in the period up to today (cancelled and buffer slots excluded). Still planned = lectures later in the period.
              Weekly hrs = the faculty’s classes on the current Batch Scheduler timetable.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
