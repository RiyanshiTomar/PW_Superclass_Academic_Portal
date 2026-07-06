'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { DAYS, formatTime } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Lecture = {
  id: string
  planned_date: string
  start_time: string | null
  duration_minutes: number
  topic_name: string
  chapter: string
  stage: string
  batches: { name: string; centres: { name: string } | { name: string }[] | null } | { name: string; centres: { name: string } | { name: string }[] | null }[] | null
  subjects: { name: string } | { name: string }[] | null
}

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
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // Day detail modal (lists all lectures on a date)
  const [dayModal, setDayModal] = useState<string | null>(null)

  // Request modal
  const [selected, setSelected] = useState<Lecture | null>(null)
  const [mode, setMode] = useState<'reschedule' | 'cancel'>('reschedule')
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setLoading(false); return }
    const { data } = await supabase
      .from('batch_planners')
      .select('id, planned_date, start_time, duration_minutes, topic_name, chapter, stage, batches(name, centres(name)), subjects(name)')
      .eq('faculty_id', appUser.id)
      .in('stage', ['Faculty Assigned', 'Confirmed'])
      .order('planned_date', { ascending: true })
    setLectures((data ?? []) as unknown as Lecture[])
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

  const todayStr = new Date().toISOString().split('T')[0]

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear((y) => y - 1) } else setMonth((m) => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear((y) => y + 1) } else setMonth((m) => m + 1) }

  function openModal(l: Lecture) {
    setSelected(l)
    setMode('reschedule')
    setNewDate(l.planned_date)
    setNewTime(l.start_time ? l.start_time.slice(0, 5) : '')
    setReason('')
    setMessage(null)
  }

  async function submit() {
    if (!selected || !reason.trim()) return
    if (mode === 'reschedule' && !newDate) return
    setSubmitting(true)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setSubmitting(false); setMessage({ type: 'error', text: 'Session expired.' }); return }

    const { error } = await supabase.from('reschedule_requests').insert({
      planner_id: selected.id,
      requested_by: appUser.id,
      request_type: mode === 'cancel' ? 'cancel' : 'planner',
      original_date: selected.planned_date,
      original_start_time: selected.start_time,
      requested_date: mode === 'cancel' ? null : newDate,
      requested_start_time: mode === 'cancel' ? null : newTime || null,
      reason: reason.trim(),
      status: 'pending',
    })
    setSubmitting(false)
    if (error) { setMessage({ type: 'error', text: 'Failed: ' + error.message }); return }
    setSelected(null)
    setMessage({ type: 'success', text: mode === 'cancel' ? 'Cancellation request sent to Central Team.' : 'Reschedule request sent to Central Team.' })
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Calendar" description="Your assigned and confirmed lectures. Click a class to request a reschedule or cancellation." />

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
              const shown = dayLectures.slice(0, 2)
              const extra = dayLectures.length - shown.length
              return (
                <div
                  key={i}
                  className={`min-h-[100px] rounded-xl border p-1.5 transition-all duration-300 hover:shadow-md ${
                    isToday ? 'border-violet-400 bg-violet-50/50 ring-2 ring-violet-300/50' : 'border-neutral-200 bg-white/80 hover:border-violet-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs font-bold ${isToday ? 'bg-violet-600 text-white' : 'text-neutral-400'}`}>{dayNum}</span>
                    {dayLectures.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />}
                  </div>
                  <div className="space-y-1">
                    {shown.map((l, li) => {
                      const batch = one(l.batches)
                      const centre = one(batch?.centres)
                      const confirmed = l.stage === 'Confirmed'
                      return (
                        <button
                          key={l.id}
                          onClick={() => openModal(l)}
                          style={{ animationDelay: `${li * 60}ms` }}
                          className={`animate-fade-up w-full text-left rounded-lg px-1.5 py-1 text-[10px] leading-tight transition-all hover:scale-[1.03] hover:shadow-sm border-l-2 ${confirmed ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border-emerald-400' : 'bg-violet-50 hover:bg-violet-100 text-violet-900 border-violet-400'}`}
                          title={`${batch?.name ?? ''} · ${centre?.name ?? ''} · ${l.topic_name}`}
                        >
                          <div className="font-bold truncate">{formatTime(l.start_time)}</div>
                          <div className="truncate">{batch?.name ?? 'Batch'}</div>
                          <div className="truncate text-[9px] opacity-80">{l.topic_name}</div>
                        </button>
                      )
                    })}
                    {extra > 0 && (
                      <button
                        onClick={() => setDayModal(date)}
                        className="w-full rounded-lg px-1.5 py-1 text-[10px] font-bold text-violet-600 bg-violet-100/60 hover:bg-violet-200 transition-colors"
                      >
                        +{extra} more
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex gap-4 mt-4 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-violet-100 inline-block" /> Assigned</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100 inline-block" /> Confirmed</span>
        </div>
      </Card>

      {/* Day detail — all lectures on one date (handles many per day) */}
      {dayModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => setDayModal(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-neutral-200 animate-pop max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-neutral-100">
              <h3 className="font-bold text-neutral-950">
                {new Date(dayModal + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              </h3>
              <button onClick={() => setDayModal(null)} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-neutral-100 text-neutral-400">✕</button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {(byDate.get(dayModal) ?? []).map((l, li) => {
                const batch = one(l.batches)
                const centre = one(batch?.centres)
                const confirmed = l.stage === 'Confirmed'
                return (
                  <button
                    key={l.id}
                    onClick={() => { setDayModal(null); openModal(l) }}
                    style={{ animationDelay: `${li * 50}ms` }}
                    className={`animate-fade-up w-full text-left rounded-xl p-3 border-l-4 transition-all hover:scale-[1.02] hover:shadow-sm ${confirmed ? 'bg-emerald-50 border-emerald-400' : 'bg-violet-50 border-violet-400'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-neutral-900 text-sm">{formatTime(l.start_time)} · {l.duration_minutes}m</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${confirmed ? 'bg-emerald-200 text-emerald-800' : 'bg-violet-200 text-violet-800'}`}>{l.stage}</span>
                    </div>
                    <div className="text-sm font-medium text-neutral-800 mt-0.5">{batch?.name ?? 'Batch'} — {l.topic_name}</div>
                    <div className="text-xs text-neutral-500">{centre?.name ?? ''} · Ch {l.chapter}</div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200">
            <h3 className="text-lg font-bold text-neutral-950 mb-1">{selected.topic_name}</h3>
            <p className="text-sm text-neutral-500 mb-4">
              {one(selected.batches)?.name} · {new Date(selected.planned_date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
              {selected.start_time && ` at ${selected.start_time.slice(0, 5)}`}
            </p>

            <div className="flex gap-2 mb-4">
              <button onClick={() => setMode('reschedule')} className={`flex-1 h-9 rounded-lg text-sm font-semibold ${mode === 'reschedule' ? 'bg-violet-500 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Reschedule</button>
              <button onClick={() => setMode('cancel')} className={`flex-1 h-9 rounded-lg text-sm font-semibold ${mode === 'cancel' ? 'bg-red-600 text-white' : 'bg-neutral-100 text-neutral-600'}`}>Cancel Class</button>
            </div>

            {mode === 'reschedule' && (
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1">New Date</label>
                  <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1">New Time</label>
                  <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className={inputClass} />
                </div>
              </div>
            )}

            <div className="mb-4">
              <label className="block text-xs font-medium text-neutral-500 mb-1">Reason</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" placeholder={mode === 'cancel' ? 'Why cancel this class?' : 'Why reschedule?'} />
            </div>

            <p className="text-xs text-neutral-400 mb-4">
              {mode === 'cancel'
                ? 'On approval, this class is removed and later lectures of the planner slide up to fill the gap.'
                : 'On approval, this class moves and later lectures of the planner shift by the same amount.'}
            </p>

            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={submit} disabled={submitting || !reason.trim() || (mode === 'reschedule' && !newDate)}>
                {submitting ? 'Sending…' : 'Send Request'}
              </BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setSelected(null)}>Close</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
