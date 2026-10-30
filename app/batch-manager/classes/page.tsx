'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds } from '@/lib/auth'
import { formatTime, toMinutes, weeklySlotActiveOn } from '@/lib/utils'
import { minutesToTimeString } from '@/lib/validation'
import { matchClasses } from '@/lib/audit-match'
import { cascadeCancel, moveClass } from '@/lib/planners'
import { getBatchFreeWindows, type FreeWindow } from '@/lib/tests'
import { notify, notifyRoles } from '@/lib/notifications'
import { fetchAllIn } from '@/lib/supabase/fetch-all'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Batch = { id: string; name: string; centre_id: string; centres: { name: string } | { name: string }[] | null }
type Slot = {
  id: string; batch_id: string; subject_id: string | null; faculty_id: string | null; classroom_id: string | null
  day_of_week: number; start_time: string; end_time: string; effective_from: string | null; effective_to: string | null
  batches: unknown; subjects: unknown; classrooms: unknown; app_users: unknown
}
type Lec = {
  id: string; batch_id: string; subject_id: string | null; faculty_id: string | null; start_time: string | null; duration_minutes: number
  topic_name: string | null; chapter: string | null; status: string; is_buffer: boolean; app_users: unknown
}
type Cls = {
  key: string; kind: 'planned' | 'buffer' | 'unplanned'; lec: Lec | null; slot: Slot
  batchId: string; batchName: string; centre: string; subject: string; faculty: string; facultyId: string | null
  room: string; start: string; minutes: number; topic: string; chapter: string; conducted: boolean
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (!v ? null : Array.isArray(v) ? v[0] ?? null : v)
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const shift = (d: string, n: number) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10) }
const fmtDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
const input = 'w-full h-10 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

// Batch Manager: cancel or reschedule a class of their batches (batches they
// manage + every batch at their centre). Applied straight away — the same
// engine Central uses on approval — and the faculty + Central are notified.
export default function BatchManagerClasses() {
  const supabase = createClient()
  const today = istToday()
  const [me, setMe] = useState<{ id: string; name: string } | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [ready, setReady] = useState(false) // batches loaded
  const [batchFilter, setBatchFilter] = useState('')
  const [date, setDate] = useState(today)
  const [classes, setClasses] = useState<Cls[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [action, setAction] = useState<{ mode: 'cancel' | 'reschedule'; c: Cls } | null>(null)
  const [reason, setReason] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [windows, setWindows] = useState<FreeWindow[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // My batches.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      if (!au) { setLoading(false); return }
      setMe({ id: au.id, name: au.full_name })
      const centreIds = getUserCentreIds(au)
      const { data } = await supabase.from('batches').select('id, name, centre_id, batch_manager_id, status, centres(name)').neq('status', 'Merged').order('name')
      setBatches(((data ?? []) as (Batch & { batch_manager_id: string | null })[]).filter((b) => b.batch_manager_id === au.id || centreIds.includes(b.centre_id)))
      setReady(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The classes on the chosen date: every running timetable slot of my
  // batches, matched to its planner lecture (shared rule, lib/audit-match).
  const load = useCallback(async () => {
    const ids = (batchFilter ? batches.filter((b) => b.id === batchFilter) : batches).map((b) => b.id)
    if (!ids.length) { setClasses([]); setLoading(false); return }
    setLoading(true)
    const dow = new Date(date + 'T12:00:00').getDay()
    const [sRes, lRes] = await Promise.all([
      fetchAllIn<Slot>(ids, (chunk, from, to) => supabase.from('batch_schedules')
        .select('id, batch_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time, effective_from, effective_to, batches(name, start_date, end_date, status, centres(name)), subjects(name), classrooms(name), app_users(full_name)')
        .in('batch_id', chunk).eq('day_of_week', dow).order('id').range(from, to) as unknown as PromiseLike<{ data: Slot[] | null; error: { message: string } | null }>),
      fetchAllIn<Lec>(ids, (chunk, from, to) => supabase.from('batch_planners')
        .select('id, batch_id, subject_id, faculty_id, start_time, duration_minutes, topic_name, chapter, status, is_buffer, app_users!batch_planners_faculty_id_fkey(full_name)')
        .in('batch_id', chunk).eq('planned_date', date).order('id').range(from, to) as unknown as PromiseLike<{ data: Lec[] | null; error: { message: string } | null }>),
    ])
    const running = sRes.data.filter((s) => weeklySlotActiveOn(s, date))
    const out: Cls[] = matchClasses(running, lRes.data).map(({ kind, p, slot }) => {
      const b = one(slot.batches as never) as { name: string; centres: unknown } | null
      const realLec = kind === 'planned' ? p : null
      const fac = one((realLec?.app_users ?? slot.app_users) as never) as { full_name: string } | null
      return {
        key: p?.id ?? `slot:${slot.id}`, kind, lec: p, slot,
        batchId: slot.batch_id, batchName: b?.name ?? 'Batch', centre: (one(b?.centres as never) as { name: string } | null)?.name ?? '',
        subject: (one(slot.subjects as never) as { name: string } | null)?.name ?? '—',
        faculty: fac?.full_name ?? '—', facultyId: realLec?.faculty_id ?? slot.faculty_id,
        room: (one(slot.classrooms as never) as { name: string } | null)?.name ?? '—',
        start: (realLec?.start_time ?? slot.start_time).slice(0, 5),
        minutes: realLec?.duration_minutes ?? toMinutes(slot.end_time.slice(0, 5)) - toMinutes(slot.start_time.slice(0, 5)),
        topic: realLec?.topic_name ?? '', chapter: realLec?.chapter ?? '', conducted: realLec?.status === 'conducted',
      }
    }).sort((a, c) => a.start.localeCompare(c.start) || a.batchName.localeCompare(c.batchName))
    setClasses(out)
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, batchFilter, date])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (ready) void load() }, [ready, load])

  // Free slots for the reschedule target date.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (action?.mode !== 'reschedule' || !newDate) { setWindows([]); return }
    let cancelled = false
    setSlotsLoading(true)
    getBatchFreeWindows(supabase, { batchId: action.c.batchId, date: newDate, durationMinutes: action.c.minutes || 60 })
      .then((w) => { if (!cancelled) { setWindows(w); setSlotsLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, newDate])
  const timeOptions = useMemo(() => {
    const dur = action?.c.minutes || 60
    const out: string[] = []
    for (const w of windows) for (let t = toMinutes(w.start); t + dur <= toMinutes(w.end); t += 15) out.push(minutesToTimeString(t).slice(0, 5))
    return Array.from(new Set(out))
  }, [windows, action])

  const open = (mode: 'cancel' | 'reschedule', c: Cls) => { setAction({ mode, c }); setReason(''); setNewDate(''); setNewTime(''); setMessage(null) }

  async function apply() {
    if (!action || !me || !reason.trim()) return
    const c = action.c
    setSaving(true)
    let ok = false, text = ''
    if (action.mode === 'cancel') {
      if (c.lec) {
        const r = await cascadeCancel(supabase, c.lec.id)
        ok = r.ok
        text = !r.ok ? (r.error ?? 'Could not cancel.')
          : r.topicUnplaced ? 'Class cancelled. No buffer slot is left before the batch end date, so its topic is NOT re-placed — Central must add it again from Edit Planner.'
            : r.shifted > 0 ? `Class cancelled — its topic moved to the next class; ${r.shifted} lecture(s) shifted forward onto the buffer.` : 'Class cancelled.'
      } else {
        // A timetable class with no planner row: a marker makes it "no class".
        const { error } = await supabase.from('batch_planners').insert({
          batch_id: c.batchId, subject_id: c.slot.subject_id, faculty_id: c.slot.faculty_id, classroom_id: c.slot.classroom_id,
          planned_date: date, start_time: c.slot.start_time, duration_minutes: c.minutes, chapter: '', topic_name: 'Class cancelled',
          is_buffer: false, status: 'cancelled', stage: 'Confirmed',
        })
        ok = !error; text = error ? error.message : 'Class cancelled.'
      }
    } else {
      if (!c.lec || !newDate || !newTime) { setSaving(false); setMessage({ type: 'error', text: 'Pick the new date and a free time.' }); return }
      const r = await moveClass(supabase, c.lec.id, newDate, newTime)
      ok = r.ok
      text = r.ok ? `Class moved to ${fmtDay(newDate)} at ${formatTime(newTime)}.` : (r.error ?? 'Could not reschedule.')
    }
    if (ok) {
      const what = `${c.batchName} · ${c.subject} · ${fmtDay(date)} ${formatTime(c.start)}`
      const title = action.mode === 'cancel' ? 'Class cancelled' : 'Class rescheduled'
      const body = action.mode === 'cancel'
        ? `${me.name} (Batch Manager) cancelled ${what}. Reason: ${reason.trim()}`
        : `${me.name} (Batch Manager) moved ${what} to ${fmtDay(newDate)} ${formatTime(newTime)}. Reason: ${reason.trim()}`
      await Promise.all([
        notify(supabase, c.facultyId, { type: 'reschedule', title, body, link: '/faculty/calendar' }),
        notifyRoles(supabase, ['central_team'], { type: 'reschedule', title, body, link: '/central/timetable' }),
        supabase.from('audit_log').insert({
          user_id: me.id, action: `${title} by Batch Manager — ${what}`, entity_type: 'lecture', entity_id: c.lec?.id ?? null,
          details: { reason: reason.trim(), batch_id: c.batchId, date, start: c.start, ...(action.mode === 'reschedule' ? { new_date: newDate, new_time: newTime } : {}) },
        }),
      ])
      setAction(null)
      await load()
    }
    setSaving(false)
    setMessage({ type: ok ? 'success' : 'error', text })
  }

  const past = date < today
  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader title="Cancel / Reschedule" description="Classes of your batches, day by day. Cancel or move a class — it applies straight away, and the faculty and Central Team are notified." />
      {message && <Alert type={message.type}>{message.text}</Alert>}

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Date</label>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 px-3 border border-neutral-200 rounded-lg text-sm" />
          </div>
          <BtnSecondary onClick={() => setDate((d) => shift(d, -1))}>←</BtnSecondary>
          <BtnSecondary onClick={() => setDate(today)}>Today</BtnSecondary>
          <BtnSecondary onClick={() => setDate((d) => shift(d, 1))}>→</BtnSecondary>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
            <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)} className="h-10 min-w-[220px] px-3 border border-neutral-200 rounded-lg text-sm bg-white">
              <option value="">All my batches ({batches.length})</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name} — {one(b.centres)?.name ?? ''}</option>)}
            </select>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between">
          <span className="font-semibold text-neutral-950">{fmtDay(date)}</span>
          <span className="text-xs text-neutral-400">{classes.length} class(es){past ? ' · past date — view only' : ''}</span>
        </div>
        {loading ? <p className="p-8 text-center text-neutral-400">Loading…</p>
          : !batches.length ? <p className="p-8 text-center text-neutral-400">No batches are linked to you yet — ask the admin to set you as a batch&apos;s manager or link your centre.</p>
          : !classes.length ? <p className="p-8 text-center text-neutral-400">No classes on this date.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[820px]">
              <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                <th className="px-5 py-2">Time</th><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Subject · Topic</th><th className="px-3 py-2">Faculty</th><th className="px-3 py-2">Room</th><th className="px-3 py-2 text-right">Action</th>
              </tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {classes.map((c) => (
                  <tr key={c.key} className="align-top">
                    <td className="px-5 py-2.5 whitespace-nowrap font-semibold">{formatTime(c.start)}<div className="text-xs font-normal text-neutral-400">{c.minutes} min</div></td>
                    <td className="px-3 py-2.5"><div className="font-medium text-neutral-900">{c.batchName}</div><div className="text-xs text-neutral-400">{c.centre}</div></td>
                    <td className="px-3 py-2.5"><div className="font-medium">{c.subject}</div><div className="text-xs text-neutral-500">{c.kind === 'planned' ? [c.chapter, c.topic].filter(Boolean).join(' · ') : 'No topic in planner (buffer class)'}</div></td>
                    <td className="px-3 py-2.5 text-neutral-700">{c.faculty}</td>
                    <td className="px-3 py-2.5 text-neutral-500">{c.room}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {c.conducted ? <span className="text-xs font-semibold text-neutral-400">Conducted</span>
                        : past ? <span className="text-xs text-neutral-300">—</span> : (
                        <div className="inline-flex gap-1.5">
                          {c.kind === 'planned' && <button onClick={() => open('reschedule', c)} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100">Reschedule</button>}
                          <button onClick={() => open('cancel', c)} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {action && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-neutral-950 mb-1">{action.mode === 'cancel' ? 'Cancel class' : 'Reschedule class'}</h3>
            <p className="text-sm text-neutral-500 mb-4">{action.c.batchName} · {action.c.subject} · {fmtDay(date)} at {formatTime(action.c.start)} · {action.c.faculty}</p>

            {action.mode === 'cancel' ? (
              <p className="text-xs text-neutral-500 mb-3 rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                {action.c.kind === 'planned' ? 'The class won’t happen. Its topic moves to this subject’s next class and later lectures shift forward onto a buffer slot (never past the batch end date).' : 'This class has no topic in the planner — it is simply marked as not happening.'}
              </p>
            ) : (
              <>
                <label className="block text-xs font-medium text-neutral-500 mb-1">New date</label>
                <input type="date" min={today} value={newDate} onChange={(e) => { setNewDate(e.target.value); setNewTime('') }} className={`${input} mb-3`} />
                <label className="block text-xs font-medium text-neutral-500 mb-1">Free time slots</label>
                {!newDate ? <p className="text-xs text-neutral-400 mb-3">Pick a date first.</p>
                  : slotsLoading ? <p className="text-xs text-neutral-400 mb-3">Finding free slots…</p>
                  : !timeOptions.length ? <p className="text-xs text-amber-700 mb-3">No free slot for this batch that day. Pick another date.</p> : (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {timeOptions.map((t) => (
                      <button key={t} type="button" onClick={() => setNewTime(t)} className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border ${newTime === t ? 'bg-violet-600 text-white border-violet-600' : 'bg-white border-neutral-200 text-neutral-700 hover:border-violet-300'}`}>{formatTime(t)}</button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-neutral-500 mb-3 rounded-lg bg-neutral-50 border border-neutral-200 p-3">Only this class moves (same topic, faculty and room). Faculty, room and batch are re-checked, so nothing can clash. Its old time shows as “rescheduled”.</p>
              </>
            )}

            <label className="block text-xs font-medium text-neutral-500 mb-1">Reason *</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm mb-4" placeholder={action.mode === 'cancel' ? 'Why is the class cancelled?' : 'Why is the class moved?'} />
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={apply} disabled={saving || !reason.trim() || (action.mode === 'reschedule' && (!newDate || !newTime))}>{saving ? 'Saving…' : action.mode === 'cancel' ? 'Cancel class' : 'Reschedule'}</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setAction(null)}>Close</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
