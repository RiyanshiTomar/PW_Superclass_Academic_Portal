'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { computeBatchPacing, pacingWarnings, type BatchPacing, type SubjectPace } from '@/lib/pacing'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager'
type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null; end_date: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }

const todayISO = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }
const fmt = (s: string | null) => (s ? new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—')
const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)))

const STATUS: Record<SubjectPace['status'], { label: string; cls: string; bar: string }> = {
  done:       { label: 'Done',      cls: 'bg-neutral-100 text-neutral-500 border-neutral-200', bar: 'bg-neutral-400' },
  ahead:      { label: 'Ahead',     cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',  bar: 'bg-emerald-500' },
  'on-track': { label: 'On track',  cls: 'bg-sky-50 text-sky-700 border-sky-200',              bar: 'bg-sky-500' },
  behind:     { label: 'Behind',    cls: 'bg-red-50 text-red-700 border-red-200',              bar: 'bg-red-500' },
}

export default function BatchProgress({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [centres, setCentres] = useState<Centre[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [centreId, setCentreId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [pacing, setPacing] = useState<BatchPacing | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingPace, setLoadingPace] = useState(false)

  const isPrivileged = scope === 'central' || scope === 'admin'

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const [bRes, cRes] = await Promise.all([
        supabase.from('batches').select('id, name, centre_id, batch_manager_id, end_date').neq('status', 'Merged').order('name'),
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
      ])
      if (bRes.data) setBatches(bRes.data as Batch[])
      if (cRes.data) setCentres(cRes.data as Centre[])
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
    if (isPrivileged) return centreId ? batches.filter((b) => b.centre_id === centreId) : []
    if (scope === 'batch-manager' && appUser) return batches.filter((b) => b.batch_manager_id === appUser.id)
    return batches.filter((b) => allowedCentreIds.has(b.centre_id))
  }, [batches, isPrivileged, scope, appUser, allowedCentreIds, centreId])

  const myCentres = useMemo(() => centres.filter((c) => allowedCentreIds.has(c.id)), [centres, allowedCentreIds])

  useEffect(() => {
    if (!batchId) { setPacing(null); return }
    let cancelled = false
    ;(async () => {
      setLoadingPace(true)
      const p = await computeBatchPacing(supabase, batchId, todayISO())
      if (!cancelled) { setPacing(p); setLoadingPace(false) }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  const totals = useMemo(() => {
    if (!pacing) return null
    const total = pacing.subjects.reduce((s, x) => s + x.totalLectures, 0)
    const done = pacing.subjects.reduce((s, x) => s + x.doneLectures, 0)
    const behind = pacing.subjects.filter((x) => x.status === 'behind').length
    return { total, done, remaining: total - done, behind }
  }, [pacing])

  const warnings = pacing ? pacingWarnings(pacing) : { behind: [], ahead: [] }
  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const tile = 'rounded-2xl p-4 border shadow-sm'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Batch Progress" description="How each subject is pacing against the batch's end date — planned vs done lectures, days left, and where to add or ease off. Catch a lagging subject early instead of cramming it at the end." />

      <div className="flex flex-wrap items-end gap-3 mb-6">
        {isPrivileged ? (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => { setCentreId(e.target.value); setBatchId('') }} className="h-11 min-w-[220px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : myCentres.length > 0 ? (
          <div className="pb-2 inline-flex items-center gap-2 rounded-xl border border-violet-100 bg-violet-50 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-violet-500">Centre</span>
            <span className="text-sm font-bold text-violet-900">{myCentres.map((c) => c.name).join(', ')}</span>
          </div>
        ) : null}
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className="h-11 min-w-[240px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading || (isPrivileged && !centreId)}>
            <option value="">{(isPrivileged && !centreId) ? 'Select a centre first' : visibleBatches.length ? 'Select a batch' : 'No batches'}</option>
            {visibleBatches.map((b) => <option key={b.id} value={b.id}>{b.name}{isPrivileged ? '' : ` — ${centreName(b.centre_id)}`}</option>)}
          </select>
        </div>
      </div>

      {!batchId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch to see its subject-wise progress.</Card>
      ) : loadingPace ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : !pacing || pacing.subjects.length === 0 ? (
        <Alert type="info">No planner lectures for this batch yet — create its planner first (Central Hub → Batch Planner).</Alert>
      ) : (
        <div className="space-y-6">
          {/* Batch tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className={`${tile} border-violet-100 bg-gradient-to-br from-violet-50 to-white`}><div className="text-3xl font-black text-violet-600">{pacing.daysLeft}</div><div className="text-xs font-medium text-violet-900/60 mt-1">Days left (till {fmt(pacing.endDate)})</div></div>
            <div className={`${tile} border-sky-100 bg-gradient-to-br from-sky-50 to-white`}><div className="text-3xl font-black text-sky-600">{totals?.done}<span className="text-lg text-neutral-400">/{totals?.total}</span></div><div className="text-xs font-medium text-sky-900/60 mt-1">Lectures done</div></div>
            <div className={`${tile} border-emerald-100 bg-gradient-to-br from-emerald-50 to-white`}><div className="text-3xl font-black text-emerald-600">{totals?.remaining}</div><div className="text-xs font-medium text-emerald-900/60 mt-1">Lectures remaining</div></div>
            <div className={`${tile} ${totals && totals.behind > 0 ? 'border-red-100 bg-gradient-to-br from-red-50 to-white' : 'border-neutral-100 bg-white'}`}><div className={`text-3xl font-black ${totals && totals.behind > 0 ? 'text-red-600' : 'text-neutral-400'}`}>{totals?.behind}</div><div className="text-xs font-medium text-neutral-500 mt-1">Subject(s) behind</div></div>
          </div>

          {/* Suggestions */}
          {(warnings.behind.length > 0 || warnings.ahead.length > 0) && (
            <Card className="p-5">
              <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3">Suggestions</h4>
              <ul className="space-y-1.5 text-sm">
                {warnings.behind.map((w, i) => <li key={`b${i}`} className="flex gap-2 text-red-700"><span>⚠</span><span>{w}</span></li>)}
                {warnings.ahead.map((w, i) => <li key={`a${i}`} className="flex gap-2 text-emerald-700"><span>✓</span><span>{w}</span></li>)}
              </ul>
            </Card>
          )}

          {/* Per-subject table */}
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100"><h4 className="font-semibold text-neutral-950">Subject-wise pacing</h4></div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="px-5 py-2">Subject</th><th className="px-3 py-2 min-w-[150px]">Progress</th><th className="px-3 py-2">Done / Total</th><th className="px-3 py-2">Hours</th><th className="px-3 py-2">Finishes</th><th className="px-3 py-2">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {pacing.subjects.map((s) => {
                    const pct = s.totalLectures ? clampPct((s.doneLectures / s.totalLectures) * 100) : 0
                    const st = STATUS[s.status]
                    return (
                      <tr key={s.subjectId} className="hover:bg-neutral-50/60">
                        <td className="px-5 py-2 font-medium text-neutral-900">{s.name}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-2 bg-neutral-100 rounded-full overflow-hidden"><div className={`h-full ${st.bar}`} style={{ width: `${pct}%` }} /></div>
                            <span className="text-[11px] font-semibold text-neutral-500 w-8">{pct}%</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{s.doneLectures} / {s.totalLectures}</td>
                        <td className="px-3 py-2 tabular-nums text-neutral-500">{s.doneHours} / {s.totalHours}h</td>
                        <td className="px-3 py-2 whitespace-nowrap text-neutral-600">{fmt(s.finishDate)}{s.marginDays != null && s.status !== 'done' && <span className={`ml-1 text-[11px] ${s.marginDays < 0 ? 'text-red-600' : 'text-neutral-400'}`}>({s.marginDays < 0 ? `${Math.abs(s.marginDays)}d over` : `${s.marginDays}d spare`})</span>}</td>
                        <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border ${st.cls}`}>{st.label}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
