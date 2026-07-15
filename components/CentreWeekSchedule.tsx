'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds } from '@/lib/auth'
import { formatTime, stageBadgeClass, addDaysToDate } from '@/lib/utils'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Centre = { id: string; name: string; branch_head_id: string | null }
type Batch = { id: string; name: string; centre_id: string }
type Lecture = {
  id: string
  batch_id: string
  stage: string
  topic_name: string
  chapter: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
  subjects: { name: string } | { name: string }[] | null
  app_users: { full_name: string } | { full_name: string }[] | null
  classrooms: { name: string } | { name: string }[] | null
}
type WeekGroup = { weekStart: string; label: string; lectures: Lecture[]; confirmed: number }

function one<T>(v: T | T[] | null): T | null { return !v ? null : Array.isArray(v) ? v[0] ?? null : v }
const todayISO = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }

function weekStartMonday(iso: string): string {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()))
  return d.toISOString().split('T')[0]
}
function weekLabel(mondayIso: string): string {
  const s = new Date(mondayIso + 'T12:00:00')
  const e = new Date(addDaysToDate(mondayIso, 6) + 'T12:00:00')
  const f = (dt: Date) => dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${f(s)} – ${f(e)}`
}

export default function CentreWeekSchedule({ scope = 'branch' }: { scope?: 'central' | 'branch' }) {
  const supabase = createClient()
  const [centres, setCentres] = useState<Centre[]>([])
  const [centreId, setCentreId] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [batchId, setBatchId] = useState('') // '' = all batches
  const [lectures, setLectures] = useState<Lecture[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingWeeks, setLoadingWeeks] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: cRes } = await supabase.from('centres').select('id, name, branch_head_id').order('name')
      let list = (cRes ?? []) as Centre[]
      if (scope === 'branch') {
        const { data: { user } } = await supabase.auth.getUser()
        const au = user ? await getAppUser(supabase, user) : null
        const ids = new Set(getUserCentreIds(au))
        if (au) list.filter((c) => c.branch_head_id === au.id).forEach((c) => ids.add(c.id))
        list = list.filter((c) => ids.has(c.id))
      }
      setCentres(list)
      if (list.length === 1) setCentreId(list[0].id)
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!centreId) { setBatches([]); setLectures([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingWeeks(true); setErr(null)
      const { data: bRes } = await supabase.from('batches').select('id, name, centre_id').eq('centre_id', centreId).neq('status', 'Merged').order('name')
      const bs = (bRes ?? []) as Batch[]
      if (cancelled) return
      setBatches(bs)
      if (bs.length === 0) { setLectures([]); setLoadingWeeks(false); return }
      const { data: lRes, error } = await supabase
        .from('batch_planners')
        .select('id, batch_id, stage, topic_name, chapter, planned_date, start_time, duration_minutes, subjects(name), app_users(full_name), classrooms(name)')
        .in('batch_id', bs.map((b) => b.id))
        .order('planned_date', { ascending: true })
      if (cancelled) return
      if (error) setErr(error.message)
      setLectures((lRes ?? []) as unknown as Lecture[])
      setLoadingWeeks(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId])

  const batchName = (id: string) => batches.find((b) => b.id === id)?.name ?? 'Batch'
  const thisWeek = weekStartMonday(todayISO())

  const weeks = useMemo(() => {
    const filtered = lectures.filter((l) => (!batchId || l.batch_id === batchId))
    const byWeek = new Map<string, Lecture[]>()
    for (const l of filtered) {
      const wk = weekStartMonday(l.planned_date)
      if (!byWeek.has(wk)) byWeek.set(wk, [])
      byWeek.get(wk)!.push(l)
    }
    let list: WeekGroup[] = Array.from(byWeek.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([weekStart, lecs]) => ({
        weekStart,
        label: weekLabel(weekStart),
        lectures: lecs.sort((a, b) => a.planned_date.localeCompare(b.planned_date) || (a.start_time ?? '').localeCompare(b.start_time ?? '')),
        confirmed: lecs.filter((l) => l.stage === 'Confirmed').length,
      }))
    if (!showPast) list = list.filter((w) => w.weekStart >= thisWeek)
    return list
  }, [lectures, batchId, showPast, thisWeek])

  const centreName = centres.find((c) => c.id === centreId)?.name ?? ''

  return (
    <div>
      <PageHeader title="Weekly Schedule" description="Your centre’s classes week by week — topic, faculty & room, with each lecture’s confirmation status. Reschedules move lectures to their new week automatically." />
      {err && <Alert type="error">{err}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-5">
        {centres.length > 1 && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => { setCentreId(e.target.value); setBatchId('') }} className="h-11 min-w-[220px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {centreId && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
            <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className="h-11 min-w-[200px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
              <option value="">All batches</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        {centreId && (
          <label className="flex items-center gap-2 pb-2 text-sm text-neutral-600 cursor-pointer">
            <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-500" />
            Show past weeks
          </label>
        )}
      </div>

      {!centreId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a centre to see its weekly schedule.</Card>
      ) : loadingWeeks ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : weeks.length === 0 ? (
        <Alert type="info">No {showPast ? '' : 'upcoming '}lectures scheduled at {centreName}{batchId ? ' for this batch' : ''} yet.</Alert>
      ) : (
        <div className="space-y-4">
          {weeks.map((w) => {
            const isCurrent = w.weekStart === thisWeek
            return (
              <Card key={w.weekStart} className={`p-0 overflow-hidden ${isCurrent ? 'ring-2 ring-violet-400' : ''}`}>
                <div className="px-5 py-3 border-b border-neutral-100 flex items-center justify-between bg-neutral-50">
                  <h3 className="font-semibold text-neutral-950">Week of {w.label} {isCurrent && <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-violet-600">this week</span>}</h3>
                  <span className="text-xs text-neutral-500">{w.confirmed}/{w.lectures.length} confirmed</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm min-w-[820px]">
                    <thead><tr className="text-neutral-500 text-xs uppercase tracking-wider"><th className="px-4 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Room</th><th className="px-3 py-2">Status</th></tr></thead>
                    <tbody className="divide-y divide-neutral-100">
                      {w.lectures.map((l) => (
                        <tr key={l.id} className="hover:bg-neutral-50/60">
                          <td className="px-4 py-2 whitespace-nowrap text-neutral-700">{new Date(l.planned_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                          <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
                          <td className="px-3 py-2 text-neutral-600">{batchName(l.batch_id)}</td>
                          <td className="px-3 py-2 text-neutral-600">{one(l.subjects)?.name ?? '—'}</td>
                          <td className="px-3 py-2"><div className="font-medium text-neutral-900">{l.topic_name || '—'}</div>{l.chapter && <div className="text-xs text-neutral-400">Ch {l.chapter}</div>}</td>
                          <td className="px-3 py-2 text-neutral-600">{one(l.app_users)?.full_name ?? '—'}</td>
                          <td className="px-3 py-2 text-neutral-600">{one(l.classrooms)?.name ?? '—'}</td>
                          <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(l.stage)}`}>{l.stage === 'Faculty Assigned' ? 'Pending' : l.stage}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
