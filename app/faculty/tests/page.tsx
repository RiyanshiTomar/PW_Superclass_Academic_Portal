'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { stageBadgeClass, formatTime } from '@/lib/utils'
import { notifyRoles } from '@/lib/notifications'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type TestRow = {
  id: string; name: string; test_date: string; start_time: string; duration_minutes: number
  test_type: string; part_type: string; stage: string; subject_id: string | null
  batches: { name: string } | { name: string }[] | null
  subjects: { name: string } | { name: string }[] | null
  classrooms: { name: string; room_no: string | null } | { name: string; room_no: string | null }[] | null
}
function one<T>(v: T | T[] | null): T | null { return !v ? null : Array.isArray(v) ? v[0] ?? null : v }

export default function FacultyTestsPage() {
  const supabase = createClient()
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [tests, setTests] = useState<TestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // Reschedule modal
  const [sel, setSel] = useState<TestRow | null>(null)
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const au = user ? await getAppUser(supabase, user) : null
    if (!au) { setLoading(false); return }
    setAppUserId(au.id)
    const { data } = await supabase
      .from('test_schedules')
      .select('id, name, test_date, start_time, duration_minutes, test_type, part_type, stage, subject_id, batches(name), subjects(name), classrooms(name, room_no)')
      .eq('faculty_id', au.id)
      .in('stage', ['Faculty Assigned', 'Confirmed', 'Rework'])
      .order('test_date', { ascending: true })
    setTests((data ?? []) as unknown as TestRow[])
    setLoading(false)
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [])

  const confirm = async (t: TestRow) => {
    if (!appUserId) return
    setBusyId(t.id); setMsg(null)
    const { error } = await supabase.from('test_schedules').update({ stage: 'Confirmed' }).eq('id', t.id).eq('faculty_id', appUserId).eq('stage', 'Faculty Assigned')
    setBusyId(null)
    if (error) return setMsg({ type: 'error', text: error.message })
    await notifyRoles(supabase, ['central_team'], { type: 'test', title: 'Test confirmed', body: `${t.name || 'Test'} · ${one(t.batches)?.name ?? ''} confirmed by faculty.`, link: '/central/tests' })
    setMsg({ type: 'success', text: 'Test confirmed — it now shows on your calendar.' })
    await load()
  }

  const openReschedule = (t: TestRow) => {
    setSel(t); setNewDate(t.test_date); setNewTime(t.start_time.slice(0, 5)); setReason(''); setMsg(null)
  }

  const submitReschedule = async () => {
    if (!sel || !appUserId || !reason.trim() || !newDate) return
    setSubmitting(true)
    const { error } = await supabase.from('reschedule_requests').insert({
      test_id: sel.id,
      requested_by: appUserId,
      request_type: 'test',
      original_date: sel.test_date,
      original_start_time: sel.start_time,
      requested_date: newDate,
      requested_start_time: newTime || null,
      reason: reason.trim(),
      status: 'pending',
    })
    setSubmitting(false)
    if (error) return setMsg({ type: 'error', text: 'Failed: ' + error.message })
    await notifyRoles(supabase, ['central_team'], { type: 'reschedule', title: 'Test reschedule request', body: `${sel.name || 'Test'} — ${one(sel.batches)?.name ?? ''}.`, link: '/central/reschedule-requests' })
    setSel(null)
    setMsg({ type: 'success', text: 'Reschedule request sent to Central Team.' })
    await load()
  }

  const roomText = (v: TestRow['classrooms']) => { const r = one(v); return r ? (r.room_no ? `${r.room_no} · ${r.name}` : r.name) : null }
  const input = 'w-full h-10 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="My Tests" description="Tests assigned to you. Confirm one to lock it onto your calendar, or request a reschedule." />
      {msg && <Alert type={msg.type === 'info' ? 'info' : msg.type}>{msg.text}</Alert>}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : tests.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-neutral-600 font-medium mb-1">No tests for you yet</p>
          <p className="text-sm text-neutral-400">When the Central Team assigns a test to you, it appears here.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {tests.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-neutral-950">{t.name || 'Test'}</span>
                    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ring-1 ${stageBadgeClass(t.stage)}`}>{t.stage}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{t.test_type}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">{t.part_type === 'Full' ? 'Full syllabus' : 'Part'}</span>
                  </div>
                  <p className="text-sm text-neutral-700 mt-1">
                    {one(t.batches)?.name ?? 'Batch'} · {new Date(t.test_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · {formatTime(t.start_time)} · {t.duration_minutes}m
                  </p>
                  <p className="text-xs text-neutral-500 mt-0.5">{roomText(t.classrooms) ?? 'No room'}{t.part_type === 'Part' && one(t.subjects)?.name ? ` · ${one(t.subjects)!.name}` : ''}</p>
                  {t.stage === 'Rework' && <p className="text-xs text-amber-700 mt-1">Central sent this back for changes. It’ll be re-sent once updated.</p>}
                </div>
                <div className="flex items-center gap-2">
                  {t.stage === 'Faculty Assigned' && (
                    <button onClick={() => confirm(t)} disabled={busyId === t.id} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Confirm</button>
                  )}
                  {t.stage !== 'Rework' && (
                    <button onClick={() => openReschedule(t)} className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-semibold rounded-lg">Reschedule</button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200">
            <h3 className="text-lg font-bold text-neutral-950 mb-1">Reschedule — {sel.name || 'Test'}</h3>
            <p className="text-sm text-neutral-500 mb-4">{one(sel.batches)?.name} · currently {new Date(sel.test_date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} {sel.start_time.slice(0, 5)}</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">New Date</label>
                <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className={input} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">New Time</label>
                <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className={input} />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-neutral-500 mb-1">Reason</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" placeholder="Why reschedule this test?" />
            </div>
            <p className="text-xs text-neutral-400 mb-4">Central Team will re-check room, faculty & batch clashes before approving.</p>
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={submitReschedule} disabled={submitting || !reason.trim() || !newDate}>{submitting ? 'Sending…' : 'Send Request'}</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setSel(null)}>Close</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
