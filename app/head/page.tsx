'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Subj = { id: string; name: string; total: number; done: number; noSlot: number; expected: number; finish: string | null; lateDays: number | null }
type Batch = {
  id: string; name: string; centreId: string; centre: string; program: string; start: string; end: string; durationDays: number
  total: number; done: number; conducted: number; expected: number; noSlot: number
  finish: string | null; lateDays: number | null; status: string; subjects: Subj[]
}

const STATUS_STYLE: Record<string, string> = {
  'Too fast': 'bg-sky-50 text-sky-700 border-sky-200',
  'On track': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Too slow': 'bg-rose-50 text-rose-700 border-rose-200',
  'Not started': 'bg-neutral-50 text-neutral-500 border-neutral-200',
  Ended: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  'No planner': 'bg-amber-50 text-amber-700 border-amber-200',
}
const fmt = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')
const months = (d: number) => Math.round((d / 30.44) * 10) / 10
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
const vsEnd = (late: number | null) => late == null ? <span className="text-neutral-300">—</span>
  : late > 0 ? <span className="text-rose-600 font-semibold">{late}d late</span>
  : late === 0 ? <span className="text-emerald-600 font-semibold">on the end date</span>
  : <span className="text-neutral-500">{-late}d early</span>

function summary(list: Batch[]) {
  const count = (s: string) => list.filter((b) => b.status === s).length
  const judged = list.filter((b) => b.total > 0)
  return {
    batches: list.length, fast: count('Too fast'), onTrack: count('On track'), slow: count('Too slow'),
    avgMonths: list.length ? months(list.reduce((a, b) => a + b.durationDays, 0) / list.length) : null,
    completion: judged.length ? Math.round(judged.reduce((a, b) => a + (b.done / b.total) * 100, 0) / judged.length) : null,
  }
}

export default function HeadBatchPace() {
  const [data, setData] = useState<{ today: string; batches: Batch[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [scope, setScope] = useState<'running' | 'all'>('running')
  const [centre, setCentre] = useState<string | null>(null) // drill: null = whole Superclass
  const [status, setStatus] = useState<string>('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/head/pace', { cache: 'no-store' }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Could not load.')
      setData(j)
    }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'))
  }, [])

  const inScope = useMemo(() => (data?.batches ?? []).filter((b) => scope === 'all' || (b.start <= data!.today && b.end >= data!.today)), [data, scope])
  const centres = useMemo(() => {
    const m = new Map<string, { id: string; name: string; list: Batch[] }>()
    for (const b of inScope) { const c = m.get(b.centreId) ?? { id: b.centreId, name: b.centre, list: [] }; c.list.push(b); m.set(b.centreId, c) }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [inScope])
  const level = centre ? inScope.filter((b) => b.centreId === centre) : inScope
  const top = summary(level)
  const list = level.filter((b) => !status || b.status === status)
    .sort((a, b) => (b.lateDays ?? -1e9) - (a.lateDays ?? -1e9) || a.name.localeCompare(b.name))
  const centreName = centres.find((c) => c.id === centre)?.name

  const tiles = [
    { k: 'Batches', v: top.batches, s: '', f: '' },
    { k: 'Too fast', v: top.fast, s: 'syllabus ends well before end date', f: 'Too fast', c: 'text-sky-600' },
    { k: 'On track', v: top.onTrack, s: '', f: 'On track', c: 'text-emerald-600' },
    { k: 'Too slow', v: top.slow, s: 'syllabus ends after end date', f: 'Too slow', c: 'text-rose-600' },
    { k: 'Avg duration', v: top.avgMonths != null ? `${top.avgMonths} mo` : '—', s: 'start → end date', f: '' },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Batch Pace" description="How fast every batch is covering its syllabus — whole Superclass, each branch, each batch." />
      {err && <Alert type="error">{err}</Alert>}
      {!data && !err && <Card className="p-10 text-center text-neutral-400">Loading…</Card>}

      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <button onClick={() => { setCentre(null); setStatus('') }} className={centre ? 'text-violet-600 hover:underline font-semibold' : 'font-bold text-neutral-900'}>Superclass</button>
              {centreName && <> <span className="text-neutral-400">›</span> <span className="font-bold text-neutral-900">{centreName}</span></>}
            </div>
            <div className="flex rounded-xl border border-neutral-200 bg-white p-1 text-xs font-semibold">
              {([['running', 'Running batches'], ['all', 'All batches']] as const).map(([k, t]) => (
                <button key={k} onClick={() => setScope(k)} className={`px-3 h-8 rounded-lg ${scope === k ? 'bg-violet-600 text-white' : 'text-neutral-600 hover:bg-violet-50'}`}>{t}</button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {tiles.map((t) => (
              <button key={t.k} disabled={!t.f} onClick={() => setStatus(status === t.f ? '' : t.f)}
                className={`text-left rounded-2xl border bg-white p-4 shadow-sm ${t.f ? 'hover:border-violet-300' : 'cursor-default'} ${status && status === t.f ? 'ring-2 ring-violet-400' : 'border-neutral-200'}`}>
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{t.k}</div>
                <div className={`text-3xl font-black mt-1 tabular-nums ${t.c ?? 'text-neutral-950'}`}>{t.v}</div>
                {t.s && <div className="text-xs text-neutral-400 mt-0.5">{t.s}</div>}
              </button>
            ))}
          </div>

          {!centre && (
            <Card className="overflow-hidden p-0">
              <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between">
                <span className="font-semibold text-neutral-950">Branches</span><span className="text-xs text-neutral-400">Click a branch to drill down</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[700px]">
                  <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                    <th className="px-5 py-2">Branch</th><th className="px-3 py-2"># Batches</th><th className="px-3 py-2">Too fast</th><th className="px-3 py-2">On track</th>
                    <th className="px-3 py-2">Too slow</th><th className="px-3 py-2">Avg duration</th><th className="px-3 py-2">Avg syllabus done</th>
                  </tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {centres.map((c) => { const s = summary(c.list); return (
                      <tr key={c.id} onClick={() => setCentre(c.id)} className="cursor-pointer hover:bg-violet-50/50">
                        <td className="px-5 py-2.5 font-semibold text-violet-700">{c.name} ›</td>
                        <td className="px-3 py-2.5 tabular-nums">{s.batches}</td>
                        <td className="px-3 py-2.5 tabular-nums text-sky-600 font-semibold">{s.fast}</td>
                        <td className="px-3 py-2.5 tabular-nums text-emerald-600 font-semibold">{s.onTrack}</td>
                        <td className="px-3 py-2.5 tabular-nums text-rose-600 font-semibold">{s.slow}</td>
                        <td className="px-3 py-2.5 tabular-nums">{s.avgMonths != null ? `${s.avgMonths} mo` : '—'}</td>
                        <td className="px-3 py-2.5 tabular-nums">{s.completion != null ? `${s.completion}%` : '—'}</td>
                      </tr>
                    ) })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card className="overflow-hidden p-0">
            <div className="px-5 py-3 border-b border-neutral-100 flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-neutral-950">Batches {status && `· ${status}`} ({list.length})</span>
              <span className="text-xs text-neutral-400">Latest first · click a batch for subject-wise pace</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[980px]">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                  <th className="px-5 py-2">Batch</th>{!centre && <th className="px-3 py-2">Branch</th>}<th className="px-3 py-2">Dates</th><th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Syllabus done</th><th className="px-3 py-2">Marked conducted</th>
                  <th className="px-3 py-2">Syllabus ends</th><th className="px-3 py-2">vs end date</th><th className="px-3 py-2">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {list.map((b) => (
                    <Fragment key={b.id}>
                      <tr onClick={() => setOpen(open === b.id ? null : b.id)} className="cursor-pointer hover:bg-neutral-50/70 align-top">
                        <td className="px-5 py-2"><div className="font-medium text-neutral-900">{b.name}</div><div className="text-xs text-neutral-400">{b.program}</div></td>
                        {!centre && <td className="px-3 py-2 text-neutral-600">{b.centre}</td>}
                        <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{fmt(b.start)} – {fmt(b.end)}</td>
                        <td className="px-3 py-2 tabular-nums">{months(b.durationDays)} mo</td>
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap">{b.done}<span className="text-neutral-400">/{b.total}</span> <span className="text-xs text-neutral-400">({pct(b.done, b.total)}%)</span></td>
                        <td className="px-3 py-2 tabular-nums text-neutral-500">{b.total ? `${pct(b.conducted, b.total)}%` : '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{fmt(b.finish)}{b.noSlot > 0 && <div className="text-[11px] text-amber-700">⚠ {b.noSlot} lectures have no class slot</div>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs">{vsEnd(b.lateDays)}</td>
                        <td className="px-3 py-2"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[b.status] ?? ''}`}>{b.status}</span></td>
                      </tr>
                      {open === b.id && (
                        <tr className="bg-violet-50/40">
                          <td colSpan={centre ? 8 : 9} className="px-5 py-3">
                            {b.subjects.length === 0 ? <span className="text-xs text-neutral-400">No planner lectures.</span> : (
                              <table className="text-xs w-full max-w-3xl">
                                <thead><tr className="text-neutral-500 text-left"><th className="py-1 pr-4">Subject</th><th className="pr-4">Done</th><th className="pr-4">Syllabus ends</th><th className="pr-4">vs end date</th><th>No class slot</th></tr></thead>
                                <tbody>
                                  {b.subjects.map((s) => (
                                    <tr key={s.id}>
                                      <td className="py-0.5 pr-4 font-medium text-neutral-800">{s.name}</td>
                                      <td className="pr-4 tabular-nums">{s.done}/{s.total}</td>
                                      <td className="pr-4 tabular-nums">{fmt(s.finish)}</td>
                                      <td className="pr-4">{vsEnd(s.lateDays)}</td>
                                      <td className={`tabular-nums ${s.noSlot ? 'text-amber-700 font-semibold' : 'text-neutral-400'}`}>{s.noSlot || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-3 text-xs text-neutral-400 border-t border-neutral-100">
              <b>Syllabus ends</b> = date of the last lecture in the batch’s planner. Ending after the batch end date = <b>Too slow</b>;
              ending more than 15 days (or 10% of the batch length) early = <b>Too fast</b>; otherwise <b>On track</b> — the same rule as Central Hub’s “Late by” chip.
              Syllabus done counts lectures whose date has passed; marked conducted is what faculty have confirmed.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
