'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { assignPlanner, setLinkStage, cascadeReschedule } from '@/lib/planners'
import { notifyUsers } from '@/lib/notifications'
import { stageBadgeClass, formatTime } from '@/lib/utils'
import { Alert, BtnPrimary, Card } from '@/components/PortalShell'

type Planner = { id: string; name: string }
type Batch = { id: string; name: string; centre_id: string; start_date: string; end_date: string }
type Lecture = {
  id: string
  faculty_id: string | null
  topic_name: string
  chapter: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
  stage: string
  subjects: { name: string } | { name: string }[] | null
  app_users: { full_name: string } | { full_name: string }[] | null
  classrooms: { name: string } | { name: string }[] | null
}
type Link = {
  id: string
  planner_id: string
  batch_id: string
  stage: string
  planners: { name: string } | { name: string }[] | null
  batches: { name: string } | { name: string }[] | null
}

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

export default function AssignPlanner() {
  const supabase = createClient()
  const [planners, setPlanners] = useState<Planner[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [lecturesByLink, setLecturesByLink] = useState<Record<string, Lecture[]>>({})

  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const [plannerId, setPlannerId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [assigning, setAssigning] = useState(false)

  // Central-side "shift forward from here" (e.g. teacher on leave).
  const [shiftId, setShiftId] = useState<string | null>(null)
  const [shiftDate, setShiftDate] = useState('')
  const [shiftBusy, setShiftBusy] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const [planRes, batchRes, linkRes] = await Promise.all([
      supabase.from('planners').select('id, name').order('created_at', { ascending: false }),
      supabase.from('batches').select('id, name, centre_id, start_date, end_date').neq('status', 'Merged').order('created_at', { ascending: false }),
      supabase.from('batch_planner_links').select('id, planner_id, batch_id, stage, planners(name), batches(name)').order('created_at', { ascending: false }),
    ])
    if (planRes.data) setPlanners(planRes.data as Planner[])
    if (batchRes.data) setBatches(batchRes.data as Batch[])
    if (linkRes.data) setLinks(linkRes.data as unknown as Link[])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleAssign = async () => {
    const batch = batches.find((b) => b.id === batchId)
    if (!plannerId || !batch) {
      setMessage({ type: 'error', text: 'Pick a planner and a batch.' })
      return
    }
    setAssigning(true)
    setMessage(null)
    const res = await assignPlanner(supabase, {
      plannerId,
      batch: { id: batch.id, centre_id: batch.centre_id, start_date: batch.start_date, end_date: batch.end_date },
    })
    setAssigning(false)
    if (!res.ok) { setMessage({ type: 'error', text: res.errors.join(' · ') }); return }
    setMessage({
      type: res.errors.length ? 'info' : 'success',
      text: `Linked — ${res.imported} lecture(s) materialised${res.errors.length ? `. ${res.errors.length} skipped: ${res.errors.slice(0, 2).join('; ')}` : ''}. Now "Send to Faculty" below.`,
    })
    setPlannerId(''); setBatchId('')
    await loadData()
  }

  const changeStage = async (link: Link, stage: string) => {
    setBusyId(link.id)
    setMessage(null)
    const { error } = await setLinkStage(supabase, link.id, stage)
    setBusyId(null)
    if (error) { setMessage({ type: 'error', text: error }); return }
    setMessage({ type: 'success', text: `Stage updated to ${stage}.` })
    await loadData()
  }

  const deleteLink = async (link: Link) => {
    if (!confirm('Remove this planner from the batch? Its materialised lectures will be deleted.')) return
    setBusyId(link.id)
    const { error } = await supabase.from('batch_planner_links').delete().eq('id', link.id)
    setBusyId(null)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    await loadData()
  }

  const toggleExpand = async (link: Link) => {
    if (expanded === link.id) { setExpanded(null); return }
    setExpanded(link.id)
    if (!lecturesByLink[link.id]) {
      await reloadLectures(link.id)
    }
  }

  const reloadLectures = async (linkId: string) => {
    const { data } = await supabase
      .from('batch_planners')
      .select('id, faculty_id, topic_name, chapter, planned_date, start_time, duration_minutes, stage, subjects(name), app_users(full_name), classrooms(name)')
      .eq('link_id', linkId)
      .order('planned_date', { ascending: true })
    setLecturesByLink((prev) => ({ ...prev, [linkId]: (data ?? []) as unknown as Lecture[] }))
  }

  // Move this lecture to a new date; later lectures of the SAME faculty in the
  // link slide by the same amount (used when a teacher goes on leave).
  const applyShift = async (linkId: string, lecture: Lecture) => {
    if (!shiftDate) { setMessage({ type: 'error', text: 'Pick the new date to shift to.' }); return }
    setShiftBusy(true); setMessage(null)
    const res = await cascadeReschedule(supabase, lecture.id, shiftDate, null)
    setShiftBusy(false)
    if (!res.ok) { setMessage({ type: 'error', text: res.error ?? 'Could not shift.' }); return }
    if (lecture.faculty_id) {
      await notifyUsers(supabase, [lecture.faculty_id], { type: 'planner', title: 'Lectures rescheduled', body: `Central shifted your lecture to ${new Date(shiftDate + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. ${res.shifted} later lecture(s) moved along.`, link: '/faculty/planners' })
    }
    setMessage({ type: 'success', text: `Shifted. ${res.shifted} later lecture(s) of this faculty moved along; overlaps re-checked.` })
    setShiftId(null); setShiftDate('')
    await reloadLectures(linkId)
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const subjName = (v: Lecture['subjects']) => { const s = one(v); return s?.name ?? '—' }
  const facName = (v: Lecture['app_users']) => { const f = one(v); return f?.full_name ?? '—' }
  const roomName = (v: Lecture['classrooms']) => { const r = one(v); return r?.name ?? '—' }

  return (
    <div className="space-y-6">
      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      <Card className="p-6">
        <h3 className="font-bold text-neutral-950 mb-1">Assign a Planner to a Batch</h3>
        <p className="text-sm text-neutral-500 mb-5">Pick the planner and the batch. Each lecture is scheduled under the faculty set in the planner, with overlap checks. A planner can be assigned to many batches.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner</label>
            <select value={plannerId} onChange={(e) => setPlannerId(e.target.value)} className={inputClass}>
              <option value="">Select planner</option>
              {planners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
            <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className={inputClass}>
              <option value="">Select batch</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        <BtnPrimary onClick={handleAssign} disabled={assigning}>{assigning ? 'Assigning…' : 'Assign Planner'}</BtnPrimary>
      </Card>

      <Card className="p-6">
        <h4 className="font-semibold text-neutral-950 mb-4">Planner Assignments</h4>
        {loading ? (
          <p className="text-neutral-400 text-sm">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-neutral-400 text-sm">No assignments yet. Assign a planner above.</p>
        ) : (
          <div className="space-y-3">
            {links.map((link) => {
              const planner = one(link.planners)
              const batch = one(link.batches)
              const lectures = lecturesByLink[link.id]
              return (
                <div key={link.id} className="border border-neutral-200 rounded-xl p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-neutral-950">{planner?.name ?? 'Planner'}</span>
                      <span className="text-neutral-400">→</span>
                      <span className="font-semibold text-neutral-700">{batch?.name ?? 'Batch'}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(link.stage)}`}>{link.stage}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {(link.stage === 'Draft' || link.stage === 'Rework') && (
                        <button onClick={() => changeStage(link, 'Faculty Assigned')} disabled={busyId === link.id} className="px-3 py-1.5 bg-neutral-950 hover:bg-neutral-800 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Send to Faculty</button>
                      )}
                      {link.stage === 'Faculty Assigned' && (
                        <button onClick={() => changeStage(link, 'Rework')} disabled={busyId === link.id} className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Recall / Rework</button>
                      )}
                      <button onClick={() => toggleExpand(link)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">{expanded === link.id ? 'Hide' : 'View'}</button>
                      <button onClick={() => deleteLink(link)} disabled={busyId === link.id} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-xs font-semibold rounded-lg">Remove</button>
                    </div>
                  </div>

                  {expanded === link.id && (
                    <div className="mt-3 border-t border-neutral-100 pt-3">
                      {!lectures ? (
                        <p className="text-xs text-neutral-400">Loading lectures…</p>
                      ) : lectures.length === 0 ? (
                        <p className="text-xs text-neutral-400">No materialised lectures.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Room</th><th className="px-3 py-2 text-right">Shift</th></tr></thead>
                            <tbody className="divide-y divide-neutral-100">
                              {lectures.map((l) => (
                                <tr key={l.id}>
                                  <td className="px-3 py-2 whitespace-nowrap">{new Date(l.planned_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
                                  <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
                                  <td className="px-3 py-2"><div className="font-medium text-neutral-950">{l.topic_name}</div><div className="text-xs text-neutral-500">Ch {l.chapter}</div></td>
                                  <td className="px-3 py-2 text-neutral-600">{subjName(l.subjects)}</td>
                                  <td className="px-3 py-2 text-neutral-600">{facName(l.app_users)}</td>
                                  <td className="px-3 py-2 text-neutral-600">{roomName(l.classrooms)}</td>
                                  <td className="px-3 py-2 text-right whitespace-nowrap">
                                    {shiftId === l.id ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                        <button onClick={() => applyShift(link.id, l)} disabled={shiftBusy} className="px-2 py-1 bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">{shiftBusy ? '…' : 'Apply'}</button>
                                        <button onClick={() => { setShiftId(null); setShiftDate('') }} className="px-2 py-1 text-neutral-400 hover:text-neutral-700 text-xs">✕</button>
                                      </span>
                                    ) : (
                                      <button onClick={() => { setShiftId(l.id); setShiftDate(l.planned_date) }} className="px-2.5 py-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg" title="Move this lecture forward; later lectures of this faculty slide too">Shift ▸</button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
