'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { DAYS, formatTime, toMinutes } from '@/lib/utils'
import { minutesToTimeString } from '@/lib/validation'
import { getBatchFreeWindows, type FreeWindow } from '@/lib/tests'
import { notifyRoles } from '@/lib/notifications'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Lecture = {
  id: string
  batch_id: string
  subject_id: string | null
  planned_date: string
  start_time: string | null
  duration_minutes: number
  topic_name: string
  chapter: string
  stage: string
  batches: { name: string; centres: { name: string } | { name: string }[] | null } | { name: string; centres: { name: string } | { name: string }[] | null }[] | null
  subjects: { name: string } | { name: string }[] | null
  classrooms: { name: string } | { name: string }[] | null
}
type ConceptChapter = { id: string; name: string }
type PlannerChapter = { name: string; nextDate: string }
type ReqInfo = { status: string; type: string }
// A demo/extra lecture doesn't have to map to a syllabus chapter.
const EXTRA_TYPES = ['Extra Class', 'Demo Lecture', 'Doubt Session', 'Revision Class']

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function FacultyCalendarPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [lectures, setLectures] = useState<Lecture[]>([])
  const [reqByPlanner, setReqByPlanner] = useState<Record<string, ReqInfo>>({})
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // Day detail modal (lists all lectures on a date)
  const [dayModal, setDayModal] = useState<string | null>(null)

  // Request modal
  const [selected, setSelected] = useState<Lecture | null>(null)
  const [mode, setMode] = useState<'reschedule' | 'cancel' | 'extra' | 'prepone'>('reschedule')
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [newDuration, setNewDuration] = useState('60')
  const [extraTopic, setExtraTopic] = useState('')
  const [extraChapter, setExtraChapter] = useState('')
  const [extraType, setExtraType] = useState(EXTRA_TYPES[0])
  const [conceptChapters, setConceptChapters] = useState<ConceptChapter[]>([])
  const [plannerChapters, setPlannerChapters] = useState<PlannerChapter[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Available (overlap-free) slots for the batch on the chosen date.
  const [freeWindows, setFreeWindows] = useState<FreeWindow[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)

  const todayStr = new Date().toISOString().split('T')[0]

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setLoading(false); return }
    const [lecRes, reqRes] = await Promise.all([
      supabase
        .from('batch_planners')
        .select('id, batch_id, subject_id, planned_date, start_time, duration_minutes, topic_name, chapter, stage, batches(name, centres(name)), subjects(name), classrooms(name)')
        .eq('faculty_id', appUser.id)
        .eq('stage', 'Confirmed')   // calendar shows only what the faculty has confirmed
        .order('planned_date', { ascending: true }),
      // Faculty's own requests, so the calendar can flag pending/approved ones.
      supabase
        .from('reschedule_requests')
        .select('planner_id, status, request_type, created_at')
        .eq('requested_by', appUser.id)
        .order('created_at', { ascending: true }),
    ])
    setLectures((lecRes.data ?? []) as unknown as Lecture[])
    const map: Record<string, ReqInfo> = {}
    for (const r of (reqRes.data ?? []) as { planner_id: string | null; status: string; request_type: string }[]) {
      if (r.planner_id) map[r.planner_id] = { status: r.status, type: r.request_type } // latest wins (asc order)
    }
    setReqByPlanner(map)
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byDate = useMemo(() => {
    const map = new Map<string, Lecture[]>()
    for (const l of lectures) {
      if (!map.has(l.planned_date)) map.set(l.planned_date, [])
      map.get(l.planned_date)!.push(l)
    }
    return map
  }, [lectures])

  // Build the month grid (weeks of 7, Sun-first).
  const cells = useMemo(() => {
    const first = new Date(year, month, 1)
    const startOffset = first.getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const out: (string | null)[] = []
    for (let i = 0; i < startOffset; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      out.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [year, month])

  const isConducted = (l: Lecture) => l.planned_date < todayStr

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear((y) => y - 1) } else setMonth((m) => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear((y) => y + 1) } else setMonth((m) => m + 1) }

  // Chapters for the "teaching tags" (reschedule / extra) — the subject's Concept Tags.
  async function loadConceptTags(subjectId: string | null, initialChapter: string, initialTopic: string) {
    setConceptChapters([])
    setTagsLoading(true)
    if (!subjectId) { setTagsLoading(false); return }
    const { data: chapterRows } = await supabase.from('chapters').select('id, name, sequence_no').eq('subject_id', subjectId).order('sequence_no')
    const chapters = (chapterRows ?? []).map((chapter) => ({ id: chapter.id as string, name: chapter.name as string }))
    setConceptChapters(chapters)
    const matchingChapter = chapters.find((chapter) => chapter.name.trim().toLowerCase() === initialChapter.trim().toLowerCase())
    setExtraChapter(matchingChapter?.name ?? '')
    setExtraTopic(initialTopic.trim())
    setTagsLoading(false)
  }

  // Chapters for PREPONE — from the batch's PLANNER, this subject only, and only
  // chapters that still have upcoming (not-yet-conducted) classes.
  async function loadPlannerChapters(batchId: string, subjectId: string | null) {
    setPlannerChapters([])
    if (!subjectId) return
    const { data } = await supabase
      .from('batch_planners')
      .select('chapter, planned_date')
      .eq('batch_id', batchId).eq('subject_id', subjectId).eq('is_buffer', false)
    const byChapter = new Map<string, string>() // chapter -> earliest UPCOMING date
    for (const r of (data ?? []) as { chapter: string | null; planned_date: string }[]) {
      const ch = (r.chapter ?? '').trim()
      if (!ch || r.planned_date < todayStr) continue // skip conducted / past classes
      const cur = byChapter.get(ch)
      if (!cur || r.planned_date < cur) byChapter.set(ch, r.planned_date)
    }
    const list = Array.from(byChapter.entries()).map(([name, nextDate]) => ({ name, nextDate })).sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    setPlannerChapters(list)
  }

  function openModal(l: Lecture) {
    setSelected(l)
    // Today's class → only Cancel is allowed; future → all options.
    setMode(l.planned_date === todayStr ? 'cancel' : 'reschedule')
    setNewDate('')          // force the faculty to pick a fresh date → loads available slots
    setNewTime('')
    setNewDuration(String(l.duration_minutes || 60))
    setExtraTopic(l.topic_name)
    setExtraChapter(l.chapter)
    setExtraType(EXTRA_TYPES[0])
    setFreeWindows([])
    void loadConceptTags(l.subject_id, l.chapter, l.topic_name)
    void loadPlannerChapters(l.batch_id, l.subject_id)
    setReason('')
    setMessage(null)
  }

  // Load the batch's overlap-free windows whenever the target date / duration
  // changes (reschedule & extra only). The faculty can only request a slot that
  // fits inside one of these, so nothing ever overlaps.
  useEffect(() => {
    if (!selected || (mode !== 'reschedule' && mode !== 'extra') || !newDate) { setFreeWindows([]); return }
    let cancelled = false
    setSlotsLoading(true)
    const dur = mode === 'extra' ? (parseInt(newDuration, 10) || 60) : (selected.duration_minutes || 60)
    getBatchFreeWindows(supabase, { batchId: selected.batch_id, date: newDate, durationMinutes: dur }).then((w) => {
      if (!cancelled) { setFreeWindows(w); setSlotsLoading(false) }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, mode, newDate, newDuration])

  // Discrete start times (15-min steps) inside the free windows that fit the class.
  const slotOptions = useMemo(() => {
    if (!selected) return [] as string[]
    const dur = mode === 'extra' ? (parseInt(newDuration, 10) || 60) : (selected.duration_minutes || 60)
    const out: string[] = []
    for (const w of freeWindows) {
      for (let t = toMinutes(w.start); t + dur <= toMinutes(w.end); t += 15) out.push(minutesToTimeString(t).slice(0, 5))
    }
    return Array.from(new Set(out))
  }, [freeWindows, selected, mode, newDuration])

  async function submit() {
    if (!selected || !reason.trim()) return
    const needsTeaching = mode === 'reschedule' || mode === 'extra'
    const isSyllabusExtra = mode === 'extra' && extraType === EXTRA_TYPES[0]
    if (needsTeaching && !newDate) return
    if (needsTeaching && !newTime) { setMessage({ type: 'error', text: 'Pick an available time slot for that day.' }); return }
    if (needsTeaching && slotOptions.length > 0 && !slotOptions.includes(newTime)) { setMessage({ type: 'error', text: 'That time isn’t free for this batch — pick one of the available slots.' }); return }
    if (mode === 'reschedule' && (!extraChapter || !extraTopic.trim())) { setMessage({ type: 'error', text: 'Chapter and topic are required.' }); return }
    if (mode === 'extra' && !extraTopic.trim()) { setMessage({ type: 'error', text: 'Topic is required.' }); return }
    if (mode === 'extra' && isSyllabusExtra && !extraChapter) { setMessage({ type: 'error', text: 'Pick a chapter (or choose Demo/Doubt/Revision).' }); return }
    if (mode === 'prepone' && !extraChapter) { setMessage({ type: 'error', text: 'Pick a chapter to prepone.' }); return }
    if (mode === 'prepone' && !newDate) { setMessage({ type: 'error', text: 'Pick the date to prepone the chapter from.' }); return }

    setSubmitting(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setSubmitting(false); setMessage({ type: 'error', text: 'Session expired.' }); return }

    let requestedEnd: string | null = null
    if (mode === 'extra' && newTime) {
      const dur = parseInt(newDuration, 10) || selected.duration_minutes || 60
      requestedEnd = minutesToTimeString(toMinutes(newTime) + dur)
    }

    const requestType = mode === 'cancel' ? 'cancel' : mode === 'extra' ? 'extra' : mode === 'prepone' ? 'prepone' : 'planner'
    // Prepone carries a "start from" date (but no specific time); cancel carries neither.
    const noDate = mode === 'cancel'
    // Extra-class type (Demo / Doubt / Revision) is noted in the reason + topic.
    const topicForExtra = mode === 'extra' ? (isSyllabusExtra ? extraTopic.trim() : `${extraType}: ${extraTopic.trim()}`) : extraTopic
    const reasonOut = mode === 'extra' && !isSyllabusExtra ? `[${extraType}] ${reason.trim()}` : reason.trim()

    const { error } = await supabase.from('reschedule_requests').insert({
      planner_id: selected.id,
      requested_by: appUser.id,
      request_type: requestType,
      original_date: selected.planned_date,
      original_start_time: selected.start_time,
      requested_date: noDate ? null : newDate,
      requested_start_time: noDate ? null : newTime || null,
      requested_end_time: requestedEnd,
      extra_topic: mode === 'cancel' || mode === 'prepone' ? null : topicForExtra,
      extra_chapter: mode === 'cancel' ? null : extraChapter || null,
      reason: reasonOut,
      status: 'pending',
    })
    setSubmitting(false)
    if (error) { setMessage({ type: 'error', text: 'Failed: ' + error.message }); return }
    await notifyRoles(supabase, ['central_team'], {
      type: 'reschedule',
      title: mode === 'cancel' ? 'Cancellation request' : mode === 'extra' ? `${extraType} request` : mode === 'prepone' ? 'Prepone-chapter request' : 'Reschedule request',
      body: `${appUser.full_name} — ${mode === 'prepone' ? `chapter “${extraChapter}”` : selected.topic_name || 'a lecture'}.`,
      link: '/central/reschedule-requests',
    })
    setSelected(null)
    const sentMsg = mode === 'cancel' ? 'Cancellation request sent to Central Team.'
      : mode === 'extra' ? `${extraType} request sent to Central Team.`
        : mode === 'prepone' ? 'Prepone-chapter request sent to Central Team.'
          : 'Reschedule request sent to Central Team.'
    setMessage({ type: 'success', text: sentMsg })
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const isSyllabusExtra = mode === 'extra' && extraType === EXTRA_TYPES[0]
  const selectedConducted = !!selected && isConducted(selected)
  const selectedToday = !!selected && selected.planned_date === todayStr

  // A compact slot picker shared by reschedule & extra. Rendered via a function
  // call (not <SlotPicker/>) so inputs keep focus across re-renders.
  const slotPicker = () => (
    <div className="mb-3">
      <label className="block text-xs font-medium text-neutral-500 mb-1">Available time slots {newDate ? `· ${new Date(newDate + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}</label>
      {!newDate ? (
        <p className="text-xs text-neutral-400">Pick a date first.</p>
      ) : slotsLoading ? (
        <p className="text-xs text-neutral-400">Finding free slots…</p>
      ) : slotOptions.length === 0 ? (
        <p className="text-xs text-amber-700">No free slot for this batch on that day (every time clashes with a class or test). Pick another date.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {slotOptions.map((t) => (
            <button key={t} type="button" onClick={() => setNewTime(t)} className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border ${newTime === t ? 'bg-violet-600 text-white border-violet-600' : 'bg-white border-neutral-200 text-neutral-700 hover:border-violet-300'}`}>{formatTime(t)}</button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-neutral-400 mt-1">Only overlap-free slots are shown, so the request can never clash.</p>
    </div>
  )

  const teachingTags = () => (
    <div className="grid grid-cols-2 gap-3 mb-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
      <div className="col-span-2 text-xs font-semibold text-violet-800">What will you teach in this class? <span className="font-normal text-neutral-500">Pick the chapter; type the topic (topic is required).</span></div>
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Chapter{isSyllabusExtra || mode === 'reschedule' ? '' : ' (optional)'}</label>
        <select value={extraChapter} onChange={(e) => setExtraChapter(e.target.value)} className={inputClass} disabled={tagsLoading || conceptChapters.length === 0}>
          <option value="">{tagsLoading ? 'Loading chapters...' : conceptChapters.length ? 'Select chapter' : 'No chapters for this subject'}</option>
          {conceptChapters.map((chapter) => <option key={chapter.id} value={chapter.name}>{chapter.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Topic *</label>
        <input type="text" value={extraTopic} onChange={(e) => setExtraTopic(e.target.value)} className={inputClass} placeholder="What will you teach? (required)" />
      </div>
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Calendar" description="Your confirmed lectures. Confirm assigned planners in My Planners — they appear here once confirmed. Click an upcoming class to request a reschedule, prepone, extra/demo class or cancellation. Already-conducted classes are shown for reference only." />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      <Card className="p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <BtnSecondary onClick={prevMonth}>← Prev</BtnSecondary>
          <h3 className="font-bold text-neutral-950">{MONTHS[month]} {year}</h3>
          <BtnSecondary onClick={nextMonth}>Next →</BtnSecondary>
        </div>

        {loading ? (
          <p className="py-12 text-center text-neutral-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[11px] font-bold uppercase tracking-wider text-neutral-400 py-2">{d}</div>
            ))}
            {cells.map((date, i) => {
              if (!date) return <div key={i} className="min-h-[100px] rounded-xl bg-neutral-100/40" />
              const dayLectures = byDate.get(date) ?? []
              const isToday = date === todayStr
              const dayNum = Number(date.slice(8, 10))
              const shown = dayLectures.slice(0, 6)
              const extra = dayLectures.length - shown.length
              return (
                <div
                  key={i}
                  className={`min-h-[100px] rounded-xl border p-1.5 transition-all duration-300 hover:shadow-md ${isToday ? 'border-violet-400 bg-violet-50/50 ring-2 ring-violet-300/50' : 'border-neutral-200 bg-white/80 hover:border-violet-200'}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs font-bold ${isToday ? 'bg-violet-600 text-white' : 'text-neutral-400'}`}>{dayNum}</span>
                    {dayLectures.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />}
                  </div>
                  <div className="space-y-1">
                    {shown.map((l, li) => {
                      const batch = one(l.batches)
                      const conducted = isConducted(l)
                      const req = reqByPlanner[l.id]
                      const reqPending = req?.status === 'pending'
                      return (
                        <button
                          key={l.id}
                          onClick={() => openModal(l)}
                          style={{ animationDelay: `${li * 60}ms` }}
                          className={`animate-fade-up w-full text-left rounded-lg px-1.5 py-1 text-[10px] leading-tight transition-all hover:scale-[1.03] hover:shadow-sm border-l-2 ${conducted ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-500 border-neutral-300' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border-emerald-400'}`}
                          title={`${batch?.name ?? ''} · ${l.topic_name}${conducted ? ' (conducted)' : ''}`}
                        >
                          <div className="font-bold truncate flex items-center gap-1">{formatTime(l.start_time)}{conducted && <span className="text-[8px] font-semibold text-neutral-400">✓done</span>}</div>
                          <div className="truncate">{batch?.name ?? 'Batch'}</div>
                          <div className="truncate text-[9px] opacity-80">{l.topic_name}</div>
                          {req && (
                            <div className={`mt-0.5 truncate text-[8px] font-bold uppercase tracking-wide ${reqPending ? 'text-amber-600' : req.status === 'approved' ? 'text-emerald-600' : 'text-rose-500'}`}>
                              {reqPending ? '⏳ request pending' : req.status === 'approved' ? '✓ request approved' : '✕ request rejected'}
                            </div>
                          )}
                        </button>
                      )
                    })}
                    {extra > 0 && (
                      <button onClick={() => setDayModal(date)} className="w-full rounded-lg px-1.5 py-1 text-[10px] font-bold text-violet-600 bg-violet-100/60 hover:bg-violet-200 transition-colors">+{extra} more</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap gap-4 mt-4 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100 inline-block" /> Upcoming (confirmed)</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-neutral-200 inline-block" /> Already conducted</span>
          <span className="flex items-center gap-1"><span className="text-amber-600 font-bold">⏳</span> Request pending</span>
        </div>
      </Card>

      {/* Day detail — all lectures on one date */}
      {dayModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => setDayModal(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-neutral-200 animate-pop max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-neutral-100">
              <h3 className="font-bold text-neutral-950">{new Date(dayModal + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
              <button onClick={() => setDayModal(null)} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-neutral-100 text-neutral-400">✕</button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {(byDate.get(dayModal) ?? []).map((l, li) => {
                const batch = one(l.batches)
                const centre = one(batch?.centres)
                const conducted = isConducted(l)
                const req = reqByPlanner[l.id]
                return (
                  <button
                    key={l.id}
                    onClick={() => { setDayModal(null); openModal(l) }}
                    style={{ animationDelay: `${li * 50}ms` }}
                    className={`animate-fade-up w-full text-left rounded-xl p-3 border-l-4 transition-all hover:scale-[1.02] hover:shadow-sm ${conducted ? 'bg-neutral-100 border-neutral-300' : 'bg-emerald-50 border-emerald-400'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-neutral-900 text-sm">{formatTime(l.start_time)} · {l.duration_minutes}m</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${conducted ? 'bg-neutral-200 text-neutral-700' : 'bg-emerald-200 text-emerald-800'}`}>{conducted ? 'Conducted' : 'Confirmed'}</span>
                    </div>
                    <div className="text-sm font-medium text-neutral-800 mt-0.5">{batch?.name ?? 'Batch'} — {l.topic_name}</div>
                    <div className="text-xs text-neutral-500">{centre?.name ?? ''}{one(l.classrooms)?.name ? ` · ${one(l.classrooms)!.name}` : ''} · Ch {l.chapter}</div>
                    {req && <div className={`text-[11px] font-semibold mt-1 ${req.status === 'pending' ? 'text-amber-600' : req.status === 'approved' ? 'text-emerald-600' : 'text-rose-500'}`}>{req.status === 'pending' ? '⏳ request pending' : req.status === 'approved' ? '✓ request approved' : '✕ request rejected'}</div>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-neutral-950 mb-1">{selected.topic_name}</h3>
            <p className="text-sm text-neutral-500 mb-4">
              {one(selected.batches)?.name} · {new Date(selected.planned_date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
              {selected.start_time && ` at ${selected.start_time.slice(0, 5)}`}
            </p>

            {selectedConducted ? (
              // Conducted classes are read-only — no reschedule/prepone/cancel.
              <>
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 mb-4">
                  This class is <b>already conducted</b>. Conducted classes can’t be rescheduled, preponed or cancelled.
                  {reqByPlanner[selected.id] && <div className="mt-2 text-xs font-semibold text-neutral-500">Last request on this class: {reqByPlanner[selected.id].status}.</div>}
                </div>
                <BtnSecondary className="w-full" onClick={() => setSelected(null)}>Close</BtnSecondary>
              </>
            ) : (
              <>
                {reqByPlanner[selected.id]?.status === 'pending' && (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">⏳ A request on this class is already pending with Central.</div>
                )}

                {selectedToday ? (
                  // Today's class — only cancellation is allowed.
                  <div className="mb-4">
                    <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">This class is today — you can only <b>cancel</b> it now (reschedule / prepone / extra are for future classes).</div>
                    <button onClick={() => setMode('cancel')} className="h-9 w-full rounded-lg text-sm font-semibold bg-red-600 text-white">Cancel Class</button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <button onClick={() => { setMode('reschedule'); setNewDate(''); setNewTime('') }} className={`h-9 rounded-lg text-sm font-semibold ${mode === 'reschedule' ? 'bg-violet-500 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Reschedule</button>
                    <button onClick={() => { setMode('prepone'); setNewDate(todayStr) }} className={`h-9 rounded-lg text-sm font-semibold ${mode === 'prepone' ? 'bg-sky-600 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Prepone Chapter</button>
                    <button onClick={() => { setMode('extra'); setNewDate(''); setNewTime('') }} className={`h-9 rounded-lg text-sm font-semibold ${mode === 'extra' ? 'bg-emerald-600 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Extra / Demo</button>
                    <button onClick={() => setMode('cancel')} className={`h-9 rounded-lg text-sm font-semibold ${mode === 'cancel' ? 'bg-red-600 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Cancel Class</button>
                  </div>
                )}

                {mode === 'reschedule' && (
                  <>
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-neutral-500 mb-1">New Date</label>
                      <input type="date" min={todayStr} value={newDate} onChange={(e) => { setNewDate(e.target.value); setNewTime('') }} className={inputClass} />
                    </div>
                    {slotPicker()}
                    {teachingTags()}
                  </>
                )}

                {mode === 'prepone' && (
                  <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Chapter from Planner</label>
                    <select value={extraChapter} onChange={(e) => setExtraChapter(e.target.value)} className={inputClass} disabled={plannerChapters.length === 0}>
                      <option value="">{plannerChapters.length ? 'Select chapter' : 'No upcoming chapters to prepone'}</option>
                      {plannerChapters.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                    <label className="block text-xs font-medium text-neutral-600 mt-3 mb-1">Start from date</label>
                    <input type="date" min={todayStr} value={newDate} onChange={(e) => setNewDate(e.target.value)} className={inputClass} />
                    <p className="text-neutral-700 mt-2">
                      Prepone the <b>whole chapter</b>{' '}
                      {extraChapter ? <span className="font-semibold text-sky-700">&ldquo;{extraChapter}&rdquo;</span> : <span className="text-neutral-400">(select a chapter above)</span>}
                      {' '}({one(selected.subjects)?.name}).
                    </p>
                    <p className="text-xs text-neutral-500 mt-1">Only this subject’s <b>upcoming</b> chapters are listed (conducted ones are excluded). The whole chapter’s remaining classes move up; other upcoming chapters slide after it.</p>
                  </div>
                )}

                {mode === 'extra' && (
                  <>
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-neutral-500 mb-1">Class type</label>
                      <select value={extraType} onChange={(e) => setExtraType(e.target.value)} className={inputClass}>
                        {EXTRA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Date</label>
                        <input type="date" min={todayStr} value={newDate} onChange={(e) => { setNewDate(e.target.value); setNewTime('') }} className={inputClass} />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Duration (mins)</label>
                        <input type="number" min={15} max={480} value={newDuration} onChange={(e) => { setNewDuration(e.target.value); setNewTime('') }} className={inputClass} />
                      </div>
                    </div>
                    {slotPicker()}
                    {teachingTags()}
                  </>
                )}

                <div className="mb-4">
                  <label className="block text-xs font-medium text-neutral-500 mb-1">Reason</label>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" placeholder={mode === 'cancel' ? 'Why cancel this class?' : mode === 'extra' ? `Why do you need this ${extraType.toLowerCase()}?` : mode === 'prepone' ? 'Why prepone this chapter?' : 'Why reschedule?'} />
                </div>

                <p className="text-xs text-neutral-400 mb-4">
                  {mode === 'cancel'
                    ? 'On approval, this class is removed and later lectures of the planner slide up to fill the gap.'
                    : mode === 'extra'
                      ? 'On approval, this class is added on your chosen free slot (same batch & subject). Nothing else shifts.'
                      : mode === 'prepone'
                        ? 'On approval, this whole chapter moves to the front of the subject’s upcoming classes; other upcoming chapters slide after it (no overlap).'
                        : 'On approval, this class moves to your chosen slot and this subject’s later lectures shift to the next class-dates.'}
                </p>

                <div className="flex gap-3">
                  <BtnPrimary className="flex-1" onClick={submit} disabled={submitting || !reason.trim() || tagsLoading}>{submitting ? 'Sending…' : 'Send Request'}</BtnPrimary>
                  <BtnSecondary className="flex-1" onClick={() => setSelected(null)}>Close</BtnSecondary>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
