'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { stageBadgeClass, formatTime } from '@/lib/utils'
import { notifyRoles } from '@/lib/notifications'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

// A materialised lecture that belongs to me, with its batch/subject context.
type MyLecture = {
  id: string
  link_id: string
  stage: string
  status: string | null
  topic_name: string
  chapter: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
  subjects: { name: string } | { name: string }[] | null
  batches: { name: string } | { name: string }[] | null
  classrooms: { name: string } | { name: string }[] | null
}

// My lectures for one batch (the whole planner, all dates).
type BatchGroup = {
  batchName: string
  lectures: MyLecture[]
  pending: number // how many still awaiting my confirmation
}

type Proposed = { plannerId: string; name: string; count: number }
type PlannerLecture = { id: string; topic_name: string; chapter: string; planned_date: string; start_time: string | null; duration_minutes: number; subjects: { name: string } | { name: string }[] | null }

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

export default function FacultyPlannersPage() {
  const supabase = createClient()
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [proposed, setProposed] = useState<Proposed[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedProposed, setExpandedProposed] = useState<string | null>(null)
  const [proposedLectures, setProposedLectures] = useState<Record<string, PlannerLecture[]>>({})
  // Editable topic/chapter per lecture (what was ACTUALLY taught).
  const [edits, setEdits] = useState<Record<string, { topic_name: string; chapter: string }>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const todayISO = new Date().toISOString().split('T')[0]

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setLoading(false); return }
    setAppUserId(appUser.id)

    // Paginate + exclude buffer slots (reserved/empty rows never meant to reach
    // faculty). PostgREST caps a single select at ~1000 rows; without paging,
    // prolific faculty silently lose classes past that cutoff.
    async function fetchAllMine(facultyId: string): Promise<MyLecture[]> {
      const out: MyLecture[] = []
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('batch_planners')
          .select('id, link_id, stage, status, topic_name, chapter, planned_date, start_time, duration_minutes, subjects(name), batches(name), classrooms(name)')
          .eq('faculty_id', facultyId)
          .eq('is_buffer', false)
          .order('planned_date', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        const chunk = (data ?? []) as unknown as MyLecture[]
        out.push(...chunk)
        if (chunk.length < PAGE) break
      }
      return out
    }

    let rows: MyLecture[] = []
    try {
      const [mineRows, propRes] = await Promise.all([
        fetchAllMine(appUser.id),
        supabase.from('planner_lectures').select('planner_id, planners(name)').eq('faculty_id', appUser.id),
      ])
      rows = mineRows
      // Seed the editable fields from the current planner values.
      const seed: Record<string, { topic_name: string; chapter: string }> = {}
      for (const r of rows) seed[r.id] = { topic_name: r.topic_name ?? '', chapter: r.chapter ?? '' }
      setEdits(seed)

      // Group the whole planner by batch (all dates together).
      const byBatch = new Map<string, MyLecture[]>()
      for (const row of rows) {
        const bn = one(row.batches)?.name ?? 'Batch'
        if (!byBatch.has(bn)) byBatch.set(bn, [])
        byBatch.get(bn)!.push(row)
      }
      const groupList: BatchGroup[] = Array.from(byBatch.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([batchName, lectures]) => ({ batchName, lectures, pending: lectures.filter((l) => l.stage === 'Faculty Assigned' && l.status !== 'conducted').length }))
      setGroups(groupList)

      // Proposed = planners meant for me that aren't yet on my calendar.
      const propCount = new Map<string, { name: string; count: number }>()
      for (const r of (propRes.data ?? []) as unknown as { planner_id: string; planners: { name: string } | { name: string }[] | null }[]) {
        const p = one(r.planners)
        const cur = propCount.get(r.planner_id) ?? { name: p?.name ?? 'Planner', count: 0 }
        cur.count += 1
        propCount.set(r.planner_id, cur)
      }
      setProposed(rows.length > 0 ? [] : Array.from(propCount.entries()).map(([plannerId, v]) => ({ plannerId, name: v.name, count: v.count })))
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not load your planners.' })
    }
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setEdit = (id: string, patch: Partial<{ topic_name: string; chapter: string }>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const isDirty = (l: MyLecture) => {
    const e = edits[l.id]
    return e && (e.topic_name !== (l.topic_name ?? '') || e.chapter !== (l.chapter ?? ''))
  }

  // Save one lecture's edited topic/chapter; optionally mark it Confirmed.
  const saveOne = async (l: MyLecture, confirm: boolean) => {
    if (!appUserId) return
    const e = edits[l.id] ?? { topic_name: l.topic_name, chapter: l.chapter }
    setBusy(true); setMessage(null)
    const patch: Record<string, unknown> = { topic_name: e.topic_name.trim(), chapter: e.chapter.trim() }
    if (confirm) {
      patch.stage = 'Confirmed'
      patch.status = 'confirmed'
    }
    const { error } = await supabase.from('batch_planners').update(patch).eq('id', l.id).eq('faculty_id', appUserId)
    setBusy(false)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    if (confirm) await notifyRoles(supabase, ['central_team'], { type: 'planner', title: 'Class confirmed', body: `Faculty confirmed ${e.topic_name || 'a class'} (${new Date(l.planned_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}).`, link: '/central' })
    setMessage({ type: 'success', text: confirm ? 'Class confirmed — the planner is updated with what you taught.' : 'Saved — planner updated.' })
    await loadData()
  }

  // Confirm every still-pending (Faculty Assigned) class in a batch, saving any edits.
  const confirmBatch = async (bg: BatchGroup) => {
    if (!appUserId) return
    setBusy(true); setMessage(null)
    for (const l of bg.lectures) {
      if (l.stage !== 'Faculty Assigned' || l.status === 'conducted') continue
      const e = edits[l.id] ?? { topic_name: l.topic_name, chapter: l.chapter }
      const { error } = await supabase.from('batch_planners').update({ topic_name: e.topic_name.trim(), chapter: e.chapter.trim(), stage: 'Confirmed', status: 'confirmed' }).eq('id', l.id).eq('faculty_id', appUserId)
      if (error) { setBusy(false); setMessage({ type: 'error', text: error.message }); return }
    }
    setBusy(false)
    await notifyRoles(supabase, ['central_team'], { type: 'planner', title: 'Planner confirmed', body: `Faculty confirmed classes for ${bg.batchName}.`, link: '/central' })
    setMessage({ type: 'success', text: `Confirmed all pending classes for ${bg.batchName}.` })
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

  const subjName = (v: MyLecture['subjects']) => one(v)?.name ?? '—'
  const inputCls = 'w-full h-8 px-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  // Group a batch's classes by (subject → chapter) so every topic of a chapter
  // shows together, even if their dates differ. Chapters ordered by earliest date.
  const groupsOf = (lectures: MyLecture[]) => {
    const map = new Map<string, { subject: string; chapter: string; rows: MyLecture[] }>()
    for (const l of lectures) {
      const subject = subjName(l.subjects)
      const chapter = (l.chapter ?? '').trim() || '—'
      const key = `${subject}||${chapter}`
      if (!map.has(key)) map.set(key, { subject, chapter, rows: [] })
      map.get(key)!.rows.push(l)
    }
    const groups = Array.from(map.values())
    for (const g of groups) g.rows.sort((a, b) => a.planned_date.localeCompare(b.planned_date))
    groups.sort((a, b) => (a.rows[0]?.planned_date ?? '').localeCompare(b.rows[0]?.planned_date ?? ''))
    return groups
  }

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="My Planners" description="Your whole planner, batch by batch. For each class, confirm you taught that topic on that date — or edit the topic/chapter to what you actually taught, and the planner updates. Need an extra class or to move one? Raise a request from your Calendar; Central approves and the plan shifts." />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : groups.length === 0 && proposed.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-neutral-600 font-medium mb-1">No planners for you yet</p>
          <p className="text-sm text-neutral-400">When the Central Team sends you a planner, all its classes appear here to confirm.</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {groups.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Your planners</h3>
              {groups.map((bg) => {
                const open = expanded === bg.batchName
                return (
                <Card key={bg.batchName} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-neutral-950">{bg.batchName}</span>
                      <span className="text-xs text-neutral-500">{bg.lectures.length} class(es)</span>
                      {bg.pending > 0
                        ? <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 bg-amber-50 text-amber-700 ring-amber-200">{bg.pending} to confirm</span>
                        : <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 bg-emerald-50 text-emerald-700 ring-emerald-200">All confirmed</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {bg.pending > 0 && <button onClick={() => confirmBatch(bg)} disabled={busy} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Confirm all pending ({bg.pending})</button>}
                      <button onClick={() => setExpanded(open ? null : bg.batchName)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">{open ? 'Hide' : 'View classes'}</button>
                    </div>
                  </div>

                  {open && (
                    <div className="mt-3 border-t border-neutral-100 pt-3 space-y-4">
                      {groupsOf(bg.lectures).map((g) => (
                        <div key={`${g.subject}||${g.chapter}`} className="border border-neutral-200 rounded-xl overflow-hidden">
                          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-neutral-50 border-b border-neutral-200">
                            <span className="font-bold text-neutral-950">{g.chapter}</span>
                            <span className="text-xs text-neutral-400">{g.subject} · {g.rows.length} topic{g.rows.length === 1 ? '' : 's'}</span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm min-w-[620px]">
                              <thead><tr className="bg-white text-neutral-500 text-xs uppercase tracking-wider">
                                <th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th>
                                <th className="px-3 py-2 min-w-[220px]">Topic (taught)</th><th className="px-3 py-2 text-right">Confirm</th>
                              </tr></thead>
                              <tbody className="divide-y divide-neutral-100">
                                {g.rows.map((l) => {
                                  const e = edits[l.id] ?? { topic_name: l.topic_name, chapter: l.chapter }
                                  const conducted = l.status === 'conducted'
                                  const label = conducted
                                    ? 'Conducted'
                                    : l.stage === 'Faculty Assigned'
                                      ? 'Scheduled'
                                      : l.stage === 'Confirmed'
                                        ? 'Confirmed'
                                        : l.stage || 'Scheduled'
                                  const labelClass = conducted
                                    ? 'bg-neutral-100 text-neutral-600 ring-neutral-300'
                                    : stageBadgeClass(l.stage)
                                  return (
                                    <tr key={l.id} className={l.status === 'conducted' ? 'bg-neutral-100/70' : l.stage === 'Faculty Assigned' ? 'bg-amber-50/30' : ''}>
                                      <td className="px-3 py-2 whitespace-nowrap">
                                        {new Date(l.planned_date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                                      </td>
                                      <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(l.start_time)}</td>
                                      <td className="px-3 py-2"><input value={e.topic_name} onChange={(ev) => setEdit(l.id, { topic_name: ev.target.value })} className={inputCls} placeholder="Topic taught" /></td>
                                      <td className="px-3 py-2 text-right whitespace-nowrap">
                                        {conducted ? (
                                          <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${labelClass}`}>{label}</span>
                                        ) : l.stage === 'Faculty Assigned' ? (
                                          <button onClick={() => saveOne(l, true)} disabled={busy} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Confirm</button>
                                        ) : isDirty(l) ? (
                                          <button onClick={() => saveOne(l, false)} disabled={busy} className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Save</button>
                                        ) : (
                                          <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${labelClass}`}>{label}</span>
                                        )}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                      <p className="text-[11px] text-neutral-400">Classes are grouped by chapter (all its topics together, whatever their dates). Edit the topic to what you actually taught, then Confirm — the planner updates. To add an extra/demo class or move one, raise a request from your <b>Calendar</b>; once Central approves, the plan shifts.</p>
                    </div>
                  )}
                </Card>
                )
              })}
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
                    <p className="text-xs text-neutral-400 mt-1">Central Team has planned these for you. They appear above to confirm once scheduled onto a batch and sent.</p>
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
