'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { setLinkStage, cascadeReschedule, addExtraLecture } from '@/lib/planners'
import { computeBatchPacing, type BatchPacing } from '@/lib/pacing'
import { notifyUsers } from '@/lib/notifications'
import { stageBadgeClass, formatTime, addDaysToDate } from '@/lib/utils'
import { Alert, Card } from '@/components/PortalShell'

type Planner = { id: string; name: string }
type Batch = { id: string; name: string; centre_id: string; start_date: string; end_date: string }
type Lecture = {
  id: string
  faculty_id: string | null
  subject_id: string | null
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
  batches: { name: string; centre_id: string } | { name: string; centre_id: string }[] | null
}
type Centre = { id: string; name: string }

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

function weekStartMonday(isoD: string): string {
  const d = new Date(isoD + 'T12:00:00')
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()))
  return d.toISOString().split('T')[0]
}
function weekLabel(mon: string): string {
  const s = new Date(mon + 'T12:00:00')
  const e = new Date(addDaysToDate(mon, 6) + 'T12:00:00')
  const f = (x: Date) => x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${f(s)} – ${f(e)}`
}
function groupByWeek(lectures: Lecture[]): { weekStart: string; label: string; lectures: Lecture[] }[] {
  const m = new Map<string, Lecture[]>()
  for (const l of lectures) { const wk = weekStartMonday(l.planned_date); if (!m.has(wk)) m.set(wk, []); m.get(wk)!.push(l) }
  return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, lecs]) => ({
    weekStart, label: weekLabel(weekStart),
    lectures: lecs.sort((a, b) => a.planned_date.localeCompare(b.planned_date) || (a.start_time ?? '').localeCompare(b.start_time ?? '')),
  }))
}

export default function AssignPlanner() {
  const supabase = createClient()
  const [links, setLinks] = useState<Link[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [linkSearch, setLinkSearch] = useState('')
  const [linkCentre, setLinkCentre] = useState('')
  const [lecturesByLink, setLecturesByLink] = useState<Record<string, Lecture[]>>({})
  const [pacingByLink, setPacingByLink] = useState<Record<string, BatchPacing | null>>({})

  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Central-side "shift forward from here" (e.g. teacher on leave).
  const [shiftId, setShiftId] = useState<string | null>(null)
  const [shiftDate, setShiftDate] = useState('')
  const [shiftBusy, setShiftBusy] = useState(false)
  // Per-week flexibility: add an extra class / remove one for a specific week.
  const [addWeek, setAddWeek] = useState<string | null>(null) // weekStart whose add-form is open
  const [addForm, setAddForm] = useState<{ subjectAnchorId: string; date: string; time: string; topic: string; chapter: string }>({ subjectAnchorId: '', date: '', time: '', topic: '', chapter: '' })
  const [addBusy, setAddBusy] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const [linkRes, cRes] = await Promise.all([
      supabase.from('batch_planner_links').select('id, planner_id, batch_id, stage, planners(name), batches(name, centre_id)').order('created_at', { ascending: false }),
      supabase.from('centres').select('id, name').order('name'),
    ])
    if (linkRes.data) setLinks(linkRes.data as unknown as Link[])
    if (cRes.data) setCentres(cRes.data as Centre[])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

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
      .select('id, faculty_id, subject_id, topic_name, chapter, planned_date, start_time, duration_minutes, stage, subjects(name), app_users(full_name), classrooms(name)')
      .eq('link_id', linkId)
      .order('planned_date', { ascending: true })
    setLecturesByLink((prev) => ({ ...prev, [linkId]: (data ?? []) as unknown as Lecture[] }))
    // Refresh the pacing snapshot for this batch (drives the scheduling warnings).
    const link = links.find((l) => l.id === linkId)
    if (link) {
      const p = await computeBatchPacing(supabase, link.batch_id, new Date().toISOString().split('T')[0])
      setPacingByLink((prev) => ({ ...prev, [linkId]: p }))
    }
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

  // Distinct subjects in a link (each with an anchor lecture to clone from when
  // adding an extra class of that subject).
  const subjectsForLink = (lecs: Lecture[]) => {
    const m = new Map<string, { name: string; anchorId: string; time: string }>()
    for (const l of lecs) {
      const sid = l.subject_id ?? ''
      if (!sid || m.has(sid)) continue
      m.set(sid, { name: one(l.subjects)?.name ?? 'Subject', anchorId: l.id, time: l.start_time ? l.start_time.slice(0, 5) : '09:00' })
    }
    return Array.from(m.values())
  }

  const openAdd = (weekStart: string, lecs: Lecture[]) => {
    const subs = subjectsForLink(lecs)
    const first = subs[0]
    setAddWeek(weekStart)
    setAddForm({ subjectAnchorId: first?.anchorId ?? '', date: weekStart, time: first?.time ?? '09:00', topic: '', chapter: '' })
  }

  // Add ONE extra class to a week (flexibility over the recurring schedule).
  const submitAdd = async (linkId: string) => {
    if (!addForm.subjectAnchorId || !addForm.date) { setMessage({ type: 'error', text: 'Pick a subject and date.' }); return }
    setAddBusy(true); setMessage(null)
    const res = await addExtraLecture(supabase, addForm.subjectAnchorId, addForm.date, addForm.time || null, undefined, { topic_name: addForm.topic || null, chapter: addForm.chapter || null })
    setAddBusy(false)
    if (!res.ok) { setMessage({ type: 'error', text: res.error ?? 'Could not add the class.' }); return }
    setMessage({ type: 'success', text: 'Extra class added for this week.' })
    setAddWeek(null)
    await reloadLectures(linkId)
  }

  // Remove ONE class from a week (holiday / skip). Deletes just this lecture.
  const removeLecture = async (linkId: string, l: Lecture) => {
    const label = `${one(l.subjects)?.name ?? 'class'} on ${new Date(l.planned_date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
    if (!confirm(`Remove ${label}? This deletes just this one class from the schedule.`)) return
    const { error } = await supabase.from('batch_planners').delete().eq('id', l.id)
    if (error) { setMessage({ type: 'error', text: error.message }); return }
    setMessage({ type: 'success', text: 'Class removed from this week.' })
    await reloadLectures(linkId)
  }

  const subjName = (v: Lecture['subjects']) => { const s = one(v); return s?.name ?? '—' }
  const facName = (v: Lecture['app_users']) => { const f = one(v); return f?.full_name ?? '—' }
  const roomName = (v: Lecture['classrooms']) => { const r = one(v); return r?.name ?? '—' }

  const shownLinks = links.filter((l) => {
    const b = one(l.batches), p = one(l.planners)
    const q = linkSearch.toLowerCase().trim()
    const nameHit = !q || (p?.name ?? '').toLowerCase().includes(q) || (b?.name ?? '').toLowerCase().includes(q)
    return nameHit && (!linkCentre || b?.centre_id === linkCentre)
  })

  return (
    <div className="space-y-6">
      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      <Card className="p-6">
        <h4 className="font-semibold text-neutral-950 mb-1">Send schedule to faculty</h4>
        <p className="text-sm text-neutral-500 mb-4">Each planner is already linked to its batch (from Create Planner). Open one with <b>View</b> to send it to faculty <b>week by week</b> — keep a week as-is, or add / remove / shift a class for that week first.</p>
        {links.length > 0 && (
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Search planner / batch</label>
              <input value={linkSearch} onChange={(e) => setLinkSearch(e.target.value)} placeholder="Type a planner or batch name…" className="w-full h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
              <select value={linkCentre} onChange={(e) => setLinkCentre(e.target.value)} className="h-11 min-w-[190px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                <option value="">All centres</option>
                {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
        )}
        {loading ? (
          <p className="text-neutral-400 text-sm">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-neutral-400 text-sm">No assignments yet. Assign a planner above.</p>
        ) : shownLinks.length === 0 ? (
          <p className="text-neutral-400 text-sm">No planners match your search/centre.</p>
        ) : (
          <div className="space-y-3">
            {shownLinks.map((link) => {
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
                        <button onClick={() => changeStage(link, 'Faculty Assigned')} disabled={busyId === link.id} className="px-3 py-1.5 bg-neutral-950 hover:bg-neutral-800 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg" title="Sends the whole planner to faculty to confirm class by class.">Send to Faculty</button>
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
                        <div className="space-y-3">
                          <p className="text-xs text-neutral-400">Use <b>Send to Faculty</b> (top) to send the whole planner — faculty then confirm each class (and can correct the topic to what they actually taught). Add or shift a class here if needed before sending.</p>
                          {pacingByLink[link.id] && (() => {
                            const p = pacingByLink[link.id]!
                            const behind = p.subjects.filter((s) => s.status === 'behind')
                            const ahead = p.subjects.filter((s) => s.status === 'ahead')
                            return (
                              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                  <span className="font-semibold text-neutral-500 uppercase tracking-wider mr-1">Pacing · {p.daysLeft}d left</span>
                                  {p.subjects.map((s) => (
                                    <span key={s.subjectId} className={`px-2 py-0.5 rounded-full border ${s.status === 'behind' ? 'bg-red-50 text-red-700 border-red-200' : s.status === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s.status === 'done' ? 'bg-neutral-100 text-neutral-500 border-neutral-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`} title={`Finishes ${s.finishDate ?? '—'}${s.marginDays != null ? ` (${s.marginDays < 0 ? Math.abs(s.marginDays) + 'd over' : s.marginDays + 'd spare'})` : ''}`}>{s.name} {s.doneLectures}/{s.totalLectures}</span>
                                  ))}
                                </div>
                                {behind.length > 0 && (
                                  <p className="mt-2 text-xs text-red-700">⚠ {behind.map((s) => `${s.name} runs ${Math.abs(s.marginDays ?? 0)}d past end`).join(' · ')}.{ahead.length > 0 ? ` Slack in ${ahead.map((s) => s.name).join(', ')}.` : ''} Add classes (+ Add class) for the lagging subject(s) or start its remaining topics sooner.</p>
                                )}
                              </div>
                            )
                          })()}
                          {groupByWeek(lectures).map((wk) => {
                            const notSent = wk.lectures.filter((l) => l.stage === 'Draft' || l.stage === 'Rework').length
                            const pending = wk.lectures.filter((l) => l.stage === 'Faculty Assigned').length
                            const confirmed = wk.lectures.filter((l) => l.stage === 'Confirmed').length
                            return (
                              <div key={wk.weekStart} className="border border-neutral-200 rounded-lg overflow-hidden">
                                <div className="px-3 py-2 bg-neutral-50 flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-semibold text-neutral-800">Week of {wk.label}</span>
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="text-neutral-400">{confirmed} confirmed · {pending} pending · {notSent} not sent</span>
                                    <button onClick={() => (addWeek === wk.weekStart ? setAddWeek(null) : openAdd(wk.weekStart, lectures))} className="px-2.5 py-1 bg-white border border-neutral-200 hover:bg-neutral-100 text-neutral-700 text-xs font-semibold rounded-lg">+ Add class</button>
                                  </div>
                                </div>
                                {addWeek === wk.weekStart && (
                                  <div className="px-3 py-3 bg-violet-50 border-b border-violet-100 flex flex-wrap items-end gap-2">
                                    <div>
                                      <label className="block text-[10px] font-semibold text-neutral-500 uppercase mb-0.5">Subject</label>
                                      <select value={addForm.subjectAnchorId} onChange={(e) => setAddForm((f) => ({ ...f, subjectAnchorId: e.target.value }))} className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs">
                                        {subjectsForLink(lectures).map((s) => <option key={s.anchorId} value={s.anchorId}>{s.name}</option>)}
                                      </select>
                                    </div>
                                    <div><label className="block text-[10px] font-semibold text-neutral-500 uppercase mb-0.5">Date</label><input type="date" value={addForm.date} onChange={(e) => setAddForm((f) => ({ ...f, date: e.target.value }))} className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs" /></div>
                                    <div><label className="block text-[10px] font-semibold text-neutral-500 uppercase mb-0.5">Time</label><input type="time" value={addForm.time} onChange={(e) => setAddForm((f) => ({ ...f, time: e.target.value }))} className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs" /></div>
                                    <div><label className="block text-[10px] font-semibold text-neutral-500 uppercase mb-0.5">Topic</label><input value={addForm.topic} onChange={(e) => setAddForm((f) => ({ ...f, topic: e.target.value }))} placeholder="Topic" className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs" /></div>
                                    <div><label className="block text-[10px] font-semibold text-neutral-500 uppercase mb-0.5">Chapter</label><input value={addForm.chapter} onChange={(e) => setAddForm((f) => ({ ...f, chapter: e.target.value }))} placeholder="Ch" className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs w-20" /></div>
                                    <button onClick={() => submitAdd(link.id)} disabled={addBusy} className="h-8 px-3 bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">{addBusy ? 'Adding…' : 'Add'}</button>
                                    <button onClick={() => setAddWeek(null)} className="h-8 px-2 text-neutral-500 text-xs">Cancel</button>
                                  </div>
                                )}
                                <div className="overflow-x-auto">
                                  <table className="w-full text-left text-sm">
                                    <thead><tr className="text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Topic</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Room</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Shift</th></tr></thead>
                                    <tbody className="divide-y divide-neutral-100">
                                      {wk.lectures.map((l) => (
                                        <tr key={l.id}>
                                          <td className="px-3 py-2 whitespace-nowrap">{new Date(l.planned_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                                          <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{formatTime(l.start_time)} · {l.duration_minutes}m</td>
                                          <td className="px-3 py-2"><div className="font-medium text-neutral-950">{l.topic_name}</div><div className="text-xs text-neutral-500">Ch {l.chapter}</div></td>
                                          <td className="px-3 py-2 text-neutral-600">{subjName(l.subjects)}</td>
                                          <td className="px-3 py-2 text-neutral-600">{facName(l.app_users)}</td>
                                          <td className="px-3 py-2 text-neutral-600">{roomName(l.classrooms)}</td>
                                          <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(l.stage)}`}>{l.stage === 'Faculty Assigned' ? 'Pending' : l.stage}</span></td>
                                          <td className="px-3 py-2 text-right whitespace-nowrap">
                                            {shiftId === l.id ? (
                                              <span className="inline-flex items-center gap-1.5">
                                                <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} className="h-8 px-2 bg-white border border-neutral-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
                                                <button onClick={() => applyShift(link.id, l)} disabled={shiftBusy} className="px-2 py-1 bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">{shiftBusy ? '…' : 'Apply'}</button>
                                                <button onClick={() => { setShiftId(null); setShiftDate('') }} className="px-2 py-1 text-neutral-400 hover:text-neutral-700 text-xs">✕</button>
                                              </span>
                                            ) : (
                                              <span className="inline-flex items-center gap-1">
                                                <button onClick={() => { setShiftId(l.id); setShiftDate(l.planned_date) }} className="px-2.5 py-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg" title="Move this lecture forward; later lectures of this faculty slide too">Shift ▸</button>
                                                <button onClick={() => removeLecture(link.id, l)} className="px-2 py-1 text-red-500 hover:text-red-700 text-xs font-semibold" title="Remove this class from the schedule">✕</button>
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )
                          })}
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
