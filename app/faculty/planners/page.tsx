'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { stageBadgeClass, formatTime, addDaysToDate } from '@/lib/utils'
import { notifyRoles } from '@/lib/notifications'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

// A materialised lecture that belongs to me, with its batch/subject context.
type MyLecture = {
  id: string
  link_id: string
  stage: string
  topic_name: string
  chapter: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
  subjects: { name: string } | { name: string }[] | null
  batches: { name: string } | { name: string }[] | null
  classrooms: { name: string } | { name: string }[] | null
}

// My lectures grouped into one calendar week (Mon–Sun) so I confirm a week at a time.
type WeekGroup = {
  weekStart: string
  label: string
  lectures: MyLecture[]
  status: string
  hasAssigned: boolean
}

type Proposed = { plannerId: string; name: string; count: number }
type PlannerLecture = { id: string; topic_name: string; chapter: string; planned_date: string; start_time: string | null; duration_minutes: number; subjects: { name: string } | { name: string }[] | null }

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

// Monday of the week that contains `iso` (weeks run Mon–Sun).
function weekStartMonday(iso: string): string {
  const d = new Date(iso + 'T12:00:00')
  const day = d.getDay() // 0=Sun … 6=Sat
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().split('T')[0]
}

function weekLabel(mondayIso: string): string {
  const start = new Date(mondayIso + 'T12:00:00')
  const end = new Date(addDaysToDate(mondayIso, 6) + 'T12:00:00')
  const f = (dt: Date) => dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${f(start)} – ${f(end)}`
}

// Overall status of a week's lectures.
function deriveStatus(stages: string[]): string {
  if (stages.length > 0 && stages.every((s) => s === 'Confirmed')) return 'Confirmed'
  if (stages.includes('Rework')) return 'Rework'
  if (stages.includes('Faculty Assigned')) return 'Faculty Assigned'
  return 'Draft'
}

export default function FacultyPlannersPage() {
  const supabase = createClient()
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [weeks, setWeeks] = useState<WeekGroup[]>([])
  const [proposed, setProposed] = useState<Proposed[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedProposed, setExpandedProposed] = useState<string | null>(null)
  const [proposedLectures, setProposedLectures] = useState<Record<string, PlannerLecture[]>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setLoading(false); return }
    setAppUserId(appUser.id)

    const [mineRes, propRes] = await Promise.all([
      // My materialised lectures that have been sent to faculty.
      supabase
        .from('batch_planners')
        .select('id, link_id, stage, topic_name, chapter, planned_date, start_time, duration_minutes, subjects(name), batches(name), classrooms(name)')
        .eq('faculty_id', appUser.id)
        .in('stage', ['Faculty Assigned', 'Confirmed', 'Rework'])
        .order('planned_date', { ascending: true }),
      // Planners where I teach at least one lecture (the template).
      supabase
        .from('planner_lectures')
        .select('planner_id, planners(name)')
        .eq('faculty_id', appUser.id),
    ])

    // Group my sent lectures into calendar weeks.
    const byWeek = new Map<string, MyLecture[]>()
    for (const row of (mineRes.data ?? []) as unknown as MyLecture[]) {
      const wk = weekStartMonday(row.planned_date)
      if (!byWeek.has(wk)) byWeek.set(wk, [])
      byWeek.get(wk)!.push(row)
    }
    const weekList: WeekGroup[] = Array.from(byWeek.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([weekStart, lectures]) => {
        const stages = lectures.map((l) => l.stage)
        return { weekStart, label: weekLabel(weekStart), lectures, status: deriveStatus(stages), hasAssigned: stages.includes('Faculty Assigned') }
      })
    setWeeks(weekList)

    // Proposed = planners meant for me that aren't yet on my calendar.
    const propCount = new Map<string, { name: string; count: number }>()
    for (const r of (propRes.data ?? []) as unknown as { planner_id: string; planners: { name: string } | { name: string }[] | null }[]) {
      const p = one(r.planners)
      const cur = propCount.get(r.planner_id) ?? { name: p?.name ?? 'Planner', count: 0 }
      cur.count += 1
      propCount.set(r.planner_id, cur)
    }
    const scheduledCount = (mineRes.data ?? []).length
    setProposed(
      // Only show "proposed" when nothing of mine is scheduled yet — otherwise weeks cover it.
      scheduledCount > 0 ? [] : Array.from(propCount.entries()).map(([plannerId, v]) => ({ plannerId, name: v.name, count: v.count }))
    )
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirmWeek = async (wg: WeekGroup) => {
    if (!appUserId) return
    setBusyId(wg.weekStart)
    setMessage(null)
    const weekEnd = addDaysToDate(wg.weekStart, 6)
    const { error } = await supabase
      .from('batch_planners')
      .update({ stage: 'Confirmed' })
      .eq('faculty_id', appUserId)
      .eq('stage', 'Faculty Assigned')
      .gte('planned_date', wg.weekStart)
      .lte('planned_date', weekEnd)
    setBusyId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    await notifyRoles(supabase, ['central_team'], { type: 'planner', title: 'Week confirmed', body: `Faculty confirmed the week of ${wg.label}.`, link: '/central' })
    setMessage({ type: 'success', text: `Week of ${wg.label} confirmed — these lectures now show on your calendar.` })
    await loadData()
  }

  const toggleProposed = async (p: Proposed) => {
    if (expandedProposed === p.plannerId) { setExpandedProposed(null); return }
    setExpandedProposed(p.plannerId)
    if (!proposedLectures[p.plannerId] && appUserId) {
      const { data } = await supabase
        .from('planner_lectures')
        .select('id, topic_name, chapter, planned_date, start_time, duration_minutes, subjects(name)')
        .eq('planner_id', p.plannerId)
        .eq('faculty_id', appUserId)
        .order('sequence_no', { ascending: true })
      setProposedLectures((prev) => ({ ...prev, [p.plannerId]: (data ?? []) as unknown as PlannerLecture[] }))
    }
  }

  const subjName = (v: MyLecture['subjects']) => { const s = one(v); return s?.name ?? '—' }
  const batchName = (v: MyLecture['batches']) => { const b = one(v); return b?.name ?? 'Batch' }

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="My Planners" description="Your lectures, week by week. Confirm a week to lock it onto your calendar — each week is independent, so you can confirm as you go." />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : weeks.length === 0 && proposed.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-neutral-600 font-medium mb-1">No planners for you yet</p>
          <p className="text-sm text-neutral-400">When the Central Team plans lectures for you, they appear here week by week.</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {weeks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Your weeks</h3>
              {weeks.map((wg) => (
                <Card key={wg.weekStart} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-neutral-950">Week of {wg.label}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(wg.status)}`}>{wg.status}</span>
                      <span className="text-xs text-neutral-500">{wg.lectures.length} lecture(s)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {wg.hasAssigned && (
                        <button onClick={() => confirmWeek(wg)} disabled={busyId === wg.weekStart} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Confirm this week</button>
                      )}
                      <button onClick={() => setExpanded(expanded === wg.weekStart ? null : wg.weekStart)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">{expanded === wg.weekStart ? 'Hide' : 'View'}</button>
                    </div>
                  </div>
                  {wg.status === 'Rework' && <p className="text-xs text-amber-700 mt-2">Central sent part of this week back for rework. It will be re-sent once updated.</p>}
                  {expanded === wg.weekStart && (
                    <div className="mt-3 border-t border-neutral-100 pt-3 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Room</th></tr></thead>
                        <tbody className="divide-y divide-neutral-100">
                          {wg.lectures.map((l) => (
                            <tr key={l.id}>
                              <td className="px-3 py-2 whitespace-nowrap">{new Date(l.planned_date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                              <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
                              <td className="px-3 py-2 text-neutral-600">{batchName(l.batches)}</td>
                              <td className="px-3 py-2"><div className="font-medium text-neutral-950">{l.topic_name}</div><div className="text-xs text-neutral-500">Ch {l.chapter}</div></td>
                              <td className="px-3 py-2 text-neutral-600">{subjName(l.subjects)}</td>
                              <td className="px-3 py-2 text-neutral-600">{one(l.classrooms)?.name ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          {proposed.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Proposed for You — awaiting scheduling</h3>
              {proposed.map((p) => {
                const lectures = proposedLectures[p.plannerId]
                return (
                  <Card key={p.plannerId} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-neutral-950">{p.name}</span>
                        <span className="text-xs text-neutral-500">{p.count} lecture(s) for you</span>
                        <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 bg-neutral-100 text-neutral-600 ring-neutral-200">Proposed</span>
                      </div>
                      <button onClick={() => toggleProposed(p)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">{expandedProposed === p.plannerId ? 'Hide' : 'Preview'}</button>
                    </div>
                    <p className="text-xs text-neutral-400 mt-1">Central Team has planned these for you. They join your weeks once scheduled onto a batch and sent.</p>
                    {expandedProposed === p.plannerId && (
                      <div className="mt-3 border-t border-neutral-100 pt-3 overflow-x-auto">
                        {!lectures ? (
                          <p className="text-xs text-neutral-400">Loading…</p>
                        ) : (
                          <table className="w-full text-left text-sm">
                            <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Subject</th></tr></thead>
                            <tbody className="divide-y divide-neutral-100">
                              {lectures.map((l) => (
                                <tr key={l.id}>
                                  <td className="px-3 py-2">{new Date(l.planned_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
                                  <td className="px-3 py-2 text-neutral-500">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
                                  <td className="px-3 py-2"><div className="font-medium text-neutral-950">{l.topic_name}</div><div className="text-xs text-neutral-500">Ch {l.chapter}</div></td>
                                  <td className="px-3 py-2 text-neutral-600">{subjName(l.subjects)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
