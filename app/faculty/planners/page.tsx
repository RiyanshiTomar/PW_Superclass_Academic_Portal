'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { stageBadgeClass, formatTime } from '@/lib/utils'
import { notifyRoles } from '@/lib/notifications'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

// A materialised lecture that belongs to me, with its link + planner/batch context.
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
  batch_planner_links: { planner_id: string; planners: { name: string } | { name: string }[] | null } | { planner_id: string; planners: { name: string } | { name: string }[] | null }[] | null
}

type Group = {
  linkId: string
  plannerId: string
  plannerName: string
  batchName: string
  lectures: MyLecture[]
  status: string
  canConfirm: boolean
}

type Proposed = { plannerId: string; name: string; count: number }
type PlannerLecture = { id: string; topic_name: string; chapter: string; planned_date: string; start_time: string | null; duration_minutes: number; subjects: { name: string } | { name: string }[] | null }

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

// Overall status of my lectures in a link.
function deriveStatus(stages: string[]): string {
  if (stages.length > 0 && stages.every((s) => s === 'Confirmed')) return 'Confirmed'
  if (stages.includes('Rework')) return 'Rework'
  if (stages.includes('Faculty Assigned')) return 'Faculty Assigned'
  return 'Draft'
}

export default function FacultyPlannersPage() {
  const supabase = createClient()
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
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
        .select('id, link_id, stage, topic_name, chapter, planned_date, start_time, duration_minutes, subjects(name), batches(name), classrooms(name), batch_planner_links(planner_id, planners(name))')
        .eq('faculty_id', appUser.id)
        .in('stage', ['Faculty Assigned', 'Confirmed', 'Rework'])
        .order('planned_date', { ascending: true }),
      // Planners where I teach at least one lecture (the template).
      supabase
        .from('planner_lectures')
        .select('planner_id, planners(name)')
        .eq('faculty_id', appUser.id),
    ])

    // Group my sent lectures by link.
    const byLink = new Map<string, Group>()
    for (const row of (mineRes.data ?? []) as unknown as MyLecture[]) {
      if (!row.link_id) continue
      const link = one(row.batch_planner_links)
      const planner = one(link?.planners ?? null)
      const batch = one(row.batches)
      if (!byLink.has(row.link_id)) {
        byLink.set(row.link_id, {
          linkId: row.link_id,
          plannerId: link?.planner_id ?? '',
          plannerName: planner?.name ?? 'Planner',
          batchName: batch?.name ?? 'Batch',
          lectures: [],
          status: 'Draft',
          canConfirm: false,
        })
      }
      byLink.get(row.link_id)!.lectures.push(row)
    }
    const groupList = Array.from(byLink.values()).map((g) => {
      const stages = g.lectures.map((l) => l.stage)
      return { ...g, status: deriveStatus(stages), canConfirm: stages.includes('Faculty Assigned') }
    })
    setGroups(groupList)

    // Proposed = planners meant for me that I'm not yet actively scheduled on.
    const activePlannerIds = new Set(groupList.map((g) => g.plannerId))
    const propCount = new Map<string, { name: string; count: number }>()
    for (const r of (propRes.data ?? []) as unknown as { planner_id: string; planners: { name: string } | { name: string }[] | null }[]) {
      const p = one(r.planners)
      const cur = propCount.get(r.planner_id) ?? { name: p?.name ?? 'Planner', count: 0 }
      cur.count += 1
      propCount.set(r.planner_id, cur)
    }
    setProposed(
      Array.from(propCount.entries())
        .filter(([id]) => !activePlannerIds.has(id))
        .map(([plannerId, v]) => ({ plannerId, name: v.name, count: v.count }))
    )
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = async (g: Group) => {
    if (!appUserId) return
    setBusyId(g.linkId)
    setMessage(null)
    const { error } = await supabase
      .from('batch_planners')
      .update({ stage: 'Confirmed' })
      .eq('link_id', g.linkId)
      .eq('faculty_id', appUserId)
      .eq('stage', 'Faculty Assigned')
    setBusyId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    await notifyRoles(supabase, ['central_team'], { type: 'planner', title: 'Planner confirmed', body: `${g.plannerName} · ${g.batchName} confirmed by faculty.`, link: '/central' })
    setMessage({ type: 'success', text: 'Your lectures are confirmed — they now show on your calendar.' })
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

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="My Planners" description="Only your own lectures across planners. Confirm an assigned one to lock it onto your calendar; preview proposed ones below." />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : groups.length === 0 && proposed.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-neutral-600 font-medium mb-1">No planners for you yet</p>
          <p className="text-sm text-neutral-400">When the Central Team plans lectures for you, they appear here.</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {groups.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Assigned & Confirmed</h3>
              {groups.map((g) => (
                <Card key={g.linkId} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-neutral-950">{g.plannerName}</span>
                      <span className="text-neutral-400">·</span>
                      <span className="text-neutral-700 font-medium">{g.batchName}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(g.status)}`}>{g.status}</span>
                      <span className="text-xs text-neutral-500">{g.lectures.length} lecture(s)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {g.canConfirm && (
                        <button onClick={() => confirm(g)} disabled={busyId === g.linkId} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Confirm My Lectures</button>
                      )}
                      <button onClick={() => setExpanded(expanded === g.linkId ? null : g.linkId)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">{expanded === g.linkId ? 'Hide' : 'View'}</button>
                    </div>
                  </div>
                  {g.status === 'Rework' && <p className="text-xs text-amber-700 mt-2">Central sent this back for rework. It will be re-sent once updated.</p>}
                  {expanded === g.linkId && (
                    <div className="mt-3 border-t border-neutral-100 pt-3 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Room</th></tr></thead>
                        <tbody className="divide-y divide-neutral-100">
                          {g.lectures.map((l) => (
                            <tr key={l.id}>
                              <td className="px-3 py-2">{new Date(l.planned_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
                              <td className="px-3 py-2 text-neutral-500">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
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
                    <p className="text-xs text-neutral-400 mt-1">Central Team has planned these for you. They join your calendar once scheduled onto a batch and sent.</p>
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
