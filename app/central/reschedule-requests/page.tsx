'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { cascadeCancel, addExtraLecture, preponeChapter } from '@/lib/planners'
import { rescheduleTest, shiftSubjectForward } from '@/lib/tests'
import { freeFacultyForSlot } from '@/lib/scheduling'
import { notify } from '@/lib/notifications'
import { toMinutes } from '@/lib/utils'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type RescheduleRequest = {
  id: string
  planner_id?: string
  schedule_id?: string
  request_type: string
  original_date: string
  original_start_time?: string
  requested_date: string | null
  requested_start_time?: string | null
  requested_end_time?: string | null
  extra_topic?: string | null
  extra_chapter?: string | null
  reason: string
  status: string
  review_notes?: string
  created_at: string
  requested_by?: string
  test_id?: string
  app_users?: { full_name: string }
  batch_planners?: {
    topic_name: string
    chapter?: string
    batches?: { name: string }
    subjects?: { name: string }
  }
  test_schedules?: {
    name: string
    batches?: { name: string }
    subjects?: { name: string }
  }
}

function isTest(req: RescheduleRequest) {
  return req.request_type === 'test' || !!req.test_id
}

function isPrepone(req: RescheduleRequest) {
  return req.request_type === 'prepone'
}

function isCancellation(req: RescheduleRequest) {
  return req.request_type === 'cancel' || (req.request_type !== 'extra' && req.request_type !== 'prepone' && !isTest(req) && !req.requested_date)
}

function isExtra(req: RescheduleRequest) {
  return req.request_type === 'extra'
}

export default function RescheduleRequestsPage() {
  const supabase = createClient()
  const [requests, setRequests] = useState<RescheduleRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [reviewNotes, setReviewNotes] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  // Cancel-with-substitute review
  const [cancelReview, setCancelReview] = useState<RescheduleRequest | null>(null)
  const [freeFac, setFreeFac] = useState<{ id: string; full_name: string; teachesSubject: boolean }[]>([])
  const [freeLoading, setFreeLoading] = useState(false)
  const [subBusy, setSubBusy] = useState(false)

  useEffect(() => {
    loadRequests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  async function loadRequests() {
    setLoading(true)
    let query = supabase
      .from('reschedule_requests')
      .select(`
        *,
        app_users!reschedule_requests_requested_by_fkey(full_name),
        batch_planners(topic_name, chapter, batches(name), subjects(name)),
        test_schedules(name, batches(name), subjects(name))
      `)
      .order('created_at', { ascending: false })
    if (filter !== 'all') query = query.eq('status', filter)
    const { data } = await query
    setRequests((data || []) as unknown as RescheduleRequest[])
    setLoading(false)
  }

  async function approveRequest(req: RescheduleRequest) {
    setReviewingId(req.id)
    setMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setReviewingId(null); setMessage({ type: 'error', text: 'Session expired.' }); return }

    // A test reschedule re-validates the new slot (room/faculty/batch) then moves it.
    if (isTest(req) && req.test_id) {
      const newTime = (req.requested_start_time ?? req.original_start_time ?? '').slice(0, 5)
      const result = await rescheduleTest(supabase, req.test_id, req.requested_date!, newTime)
      // A reschedule retains the safe date-shift behaviour above, then applies
      // the selected GTT chapter/topic only to the requested lecture.
      if (result.ok && !isExtra(req) && !isPrepone(req) && !isCancellation(req) && !isTest(req) && req.extra_chapter && req.extra_topic) {
        const { error: contentError } = await supabase
          .from('batch_planners')
          .update({ chapter: req.extra_chapter, topic_name: req.extra_topic })
          .eq('id', req.planner_id)
        if (contentError) result = { ok: false, error: contentError.message }
      }
      if (!result.ok) {
        setReviewingId(null)
        setMessage({ type: 'error', text: result.error ?? 'Could not reschedule the test.' })
        return
      }
    }

    // Apply the change to the planner first (cascade), so we don't mark it
    // approved if the shift would create an overlap.
    if (req.planner_id) {
      const needsConceptTags = isExtra(req) || isPrepone(req) || (!isCancellation(req) && !isTest(req))
      if (needsConceptTags) {
        const { data: context } = await supabase.from('batch_planners').select('subject_id').eq('id', req.planner_id).single<{ subject_id: string | null }>()
        if (!context?.subject_id || !req.extra_chapter || (isPrepone(req) ? false : !req.extra_topic)) {
          setReviewingId(null)
          setMessage({ type: 'error', text: 'This request is missing its required Concept Tag chapter/topic.' })
          return
        }
        const { data: chapter } = await supabase.from('chapters').select('id').eq('subject_id', context.subject_id).eq('name', req.extra_chapter).maybeSingle<{ id: string }>()
        const topicResult = chapter && !isPrepone(req)
          ? await supabase.from('topics').select('id').eq('chapter_id', chapter.id).eq('name', req.extra_topic!).maybeSingle<{ id: string }>()
          : null
        if (!chapter || (!isPrepone(req) && !topicResult?.data)) {
          setReviewingId(null)
          setMessage({ type: 'error', text: 'The selected chapter/topic is not in this subject’s Concept Tags. Ask the faculty to submit a fresh request.' })
          return
        }
      }
      let result: { ok: boolean; error?: string }
      if (isExtra(req)) {
        const dur = req.requested_start_time && req.requested_end_time
          ? toMinutes(req.requested_end_time.slice(0, 5)) - toMinutes(req.requested_start_time.slice(0, 5))
          : undefined
        result = await addExtraLecture(supabase, req.planner_id, req.requested_date!, req.requested_start_time ?? null, dur && dur > 0 ? dur : undefined, { topic_name: req.extra_topic ?? null, chapter: req.extra_chapter ?? null })
      } else if (isCancellation(req)) {
        result = await cascadeCancel(supabase, req.planner_id)
      } else if (isPrepone(req)) {
        // Prepone the WHOLE chapter: its upcoming lectures move to the front of
        // the subject's upcoming class-dates; other chapters slide after.
        const today = new Date().toISOString().split('T')[0]
        const { data: lec } = await supabase.from('batch_planners').select('batch_id, subject_id, chapter').eq('id', req.planner_id).single<{ batch_id: string; subject_id: string | null; chapter: string }>()
        const chapter = req.extra_chapter || lec?.chapter || ''
        if (!lec?.batch_id || !lec?.subject_id || !chapter) {
          result = { ok: false, error: 'Could not find the chapter to prepone.' }
        } else {
          const r = await preponeChapter(supabase, lec.batch_id, lec.subject_id, chapter, today)
          result = r.ok ? { ok: true } : { ok: false, error: r.error }
        }
      } else {
        // Reschedule = SHIFT the planner forward. This subject's lecture on the
        // original date, and every later one, each slides to the subject's NEXT
        // scheduled class-date (re-inheriting that slot's time & room). Because
        // it rides the subject's own valid slots, it can NEVER overlap — the old
        // "move to an arbitrary date" approach is what caused overlap failures.
        const { data: lec } = await supabase.from('batch_planners').select('batch_id, subject_id, planned_date').eq('id', req.planner_id).single<{ batch_id: string; subject_id: string | null; planned_date: string }>()
        if (!lec?.batch_id || !lec?.subject_id) {
          result = { ok: false, error: 'Could not find the lecture to reschedule.' }
        } else {
          const moved = await shiftSubjectForward(supabase, lec.batch_id, lec.subject_id, lec.planned_date)
          result = moved > 0 ? { ok: true } : { ok: false, error: 'Could not shift — this subject has no scheduled class-days. Add its weekly slot first.' }
        }
      }
      if (!result.ok) {
        setReviewingId(null)
        setMessage({ type: 'error', text: result.error ?? 'Could not apply the change.' })
        return
      }
    }

    const { error } = await supabase
      .from('reschedule_requests')
      .update({ status: 'approved', reviewed_by: appUser.id, reviewed_at: new Date().toISOString(), review_notes: reviewNotes || null })
      .eq('id', req.id)

    setReviewingId(null)
    setReviewNotes('')
    if (error) { setMessage({ type: 'error', text: 'Failed to record approval: ' + error.message }); return }
    await notify(supabase, req.requested_by, { type: 'reschedule', title: 'Request approved', body: 'Your request was approved by Central.', link: isTest(req) ? '/faculty/tests' : '/faculty/calendar' })
    setMessage({ type: 'success', text: isTest(req) ? 'Approved — test moved to the new slot.' : isExtra(req) ? 'Approved — extra class added to the faculty calendar.' : isPrepone(req) ? 'Approved — chapter preponed; other chapters slid after it.' : isCancellation(req) ? 'Cancelled — later lectures shifted up.' : 'Approved — planner updated and subsequent lectures shifted.' })
    loadRequests()
  }

  // Cancel request → first show who's free for that slot (optional substitute).
  async function openCancelReview(req: RescheduleRequest) {
    setCancelReview(req); setFreeFac([]); setFreeLoading(true); setMessage(null)
    const { data: lec } = await supabase
      .from('batch_planners')
      .select('faculty_id, subject_id, planned_date, start_time, duration_minutes, batches(centre_id)')
      .eq('id', req.planner_id).single<{ faculty_id: string | null; subject_id: string | null; planned_date: string; start_time: string | null; duration_minutes: number; batches: { centre_id: string } | { centre_id: string }[] | null }>()
    const centreId = lec ? (Array.isArray(lec.batches) ? lec.batches[0]?.centre_id : lec.batches?.centre_id) : null
    if (!lec || !lec.start_time || !centreId) { setFreeLoading(false); return }
    const free = await freeFacultyForSlot(supabase, { centreId, subjectId: lec.subject_id, date: lec.planned_date, startTime: lec.start_time, durationMinutes: lec.duration_minutes, excludeFacultyId: lec.faculty_id })
    setFreeFac(free); setFreeLoading(false)
  }

  // Keep the class, just swap in a free substitute faculty (no cancellation).
  async function assignSubstitute(req: RescheduleRequest, facultyId: string, facultyName: string) {
    setSubBusy(true); setMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setSubBusy(false); setMessage({ type: 'error', text: 'Session expired.' }); return }
    const { error: uErr } = await supabase.from('batch_planners').update({ faculty_id: facultyId }).eq('id', req.planner_id)
    if (uErr) { setSubBusy(false); setMessage({ type: 'error', text: 'Could not assign substitute: ' + uErr.message }); return }
    await supabase.from('reschedule_requests').update({ status: 'approved', reviewed_by: appUser.id, reviewed_at: new Date().toISOString(), review_notes: `${reviewNotes ? reviewNotes + ' · ' : ''}Substitute: ${facultyName}` }).eq('id', req.id)
    await notify(supabase, req.requested_by, { type: 'reschedule', title: 'Cancellation handled', body: `Central kept the class with a substitute (${facultyName}).`, link: '/faculty/calendar' })
    await notify(supabase, facultyId, { type: 'planner', title: 'Class assigned to you', body: 'You have been assigned a substitute class — check your calendar.', link: '/faculty/calendar' })
    setSubBusy(false); setCancelReview(null); setReviewNotes('')
    setMessage({ type: 'success', text: `Class kept — ${facultyName} assigned as substitute.` })
    loadRequests()
  }

  async function rejectRequest(req: RescheduleRequest) {
    setReviewingId(req.id)
    setMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    const appUser = user ? await getAppUser(supabase, user) : null
    if (!appUser) { setReviewingId(null); setMessage({ type: 'error', text: 'Session expired.' }); return }

    const { error } = await supabase
      .from('reschedule_requests')
      .update({ status: 'rejected', reviewed_by: appUser.id, reviewed_at: new Date().toISOString(), review_notes: reviewNotes || null })
      .eq('id', req.id)

    setReviewingId(null)
    setReviewNotes('')
    if (error) { setMessage({ type: 'error', text: 'Failed to reject: ' + error.message }); return }
    await notify(supabase, req.requested_by, { type: 'reschedule', title: 'Request rejected', body: reviewNotes ? `Central: ${reviewNotes}` : 'Your request was rejected by Central.', link: isTest(req) ? '/faculty/tests' : '/faculty/calendar' })
    setMessage({ type: 'success', text: 'Request rejected.' })
    loadRequests()
  }

  const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—')

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="Reschedule Requests" description="Approve or reject faculty reschedule and cancellation requests. Approving cascades the change through the planner." />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      <div className="flex gap-2 mb-4">
        {(['pending', 'approved', 'rejected', 'all'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === f ? 'bg-violet-500 text-white' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-neutral-400">No {filter} requests.</p>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => {
            const test = isTest(req)
            const cancel = isCancellation(req)
            const extra = isExtra(req)
            const prepone = isPrepone(req)
            return (
              <Card key={req.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-neutral-900">
                        {test
                          ? `${req.test_schedules?.batches?.name || 'Batch'} — ${req.test_schedules?.name || 'Test'}`
                          : `${req.batch_planners?.batches?.name || 'Batch'} — ${req.batch_planners?.subjects?.name || 'Subject'}`}
                      </p>
                      {test && <span className="text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">Test</span>}
                      {cancel && <span className="text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 px-2 py-0.5 rounded-full">Cancellation</span>}
                      {extra && <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">Extra Class</span>}
                      {prepone && <span className="text-[10px] font-bold uppercase tracking-wider bg-sky-50 text-sky-700 px-2 py-0.5 rounded-full">Prepone Chapter</span>}
                    </div>
                    <p className="text-xs text-neutral-500 mt-1">Requested by: {req.app_users?.full_name || 'Unknown'}</p>
                    {req.batch_planners?.topic_name && <p className="text-xs text-neutral-500">Topic: {req.batch_planners.topic_name}</p>}
                    <p className="text-xs text-neutral-500 mt-1">
                      {prepone ? (
                        <>Prepone the whole chapter <b>“{req.extra_chapter || req.batch_planners?.chapter || '—'}”</b> to the front of {req.batch_planners?.subjects?.name || 'the subject'}&apos;s upcoming classes.</>
                      ) : cancel ? (
                        <>Cancel lecture on {fmt(req.original_date)}{req.original_start_time && ` at ${req.original_start_time.slice(0, 5)}`}</>
                      ) : extra ? (
                        <>Add an extra class on {fmt(req.requested_date)}{req.requested_start_time && ` at ${req.requested_start_time.slice(0, 5)}`}{req.requested_end_time && `–${req.requested_end_time.slice(0, 5)}`}{req.extra_topic ? ` — “${req.extra_topic}”${req.extra_chapter ? ` (Ch ${req.extra_chapter})` : ''}` : ''}</>
                      ) : (
                        <>Original: {fmt(req.original_date)}{req.original_start_time && ` at ${req.original_start_time.slice(0, 5)}`} → New: {fmt(req.requested_date)}{req.requested_start_time && ` at ${req.requested_start_time.slice(0, 5)}`}</>
                      )}
                    </p>
                    <p className="text-sm text-neutral-700 mt-2"><span className="font-medium">Reason:</span> {req.reason}</p>
                    {req.review_notes && <p className="text-xs text-neutral-500 mt-1"><span className="font-medium">Notes:</span> {req.review_notes}</p>}
                    <p className="text-xs text-neutral-400 mt-2">
                      Status: <span className={`font-medium ${req.status === 'approved' ? 'text-emerald-600' : req.status === 'rejected' ? 'text-red-600' : 'text-amber-600'}`}>{req.status}</span>
                    </p>
                  </div>
                  {req.status === 'pending' && (
                    <div className="w-52 shrink-0">
                      <textarea value={reviewingId === req.id ? reviewNotes : ''} onChange={(e) => { setReviewingId(req.id); setReviewNotes(e.target.value) }} placeholder="Notes (optional)" rows={2} className="w-full px-2 py-1 border border-neutral-300 rounded text-xs mb-2" />
                      <div className="flex gap-2">
                        <button onClick={() => (isCancellation(req) ? openCancelReview(req) : approveRequest(req))} disabled={reviewingId === req.id} className="h-8 px-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">{isCancellation(req) ? 'Review & Approve' : 'Approve'}</button>
                        <button onClick={() => rejectRequest(req)} disabled={reviewingId === req.id} className="h-8 px-3 bg-red-600 hover:bg-red-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Reject</button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {cancelReview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => !subBusy && setCancelReview(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-neutral-200 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-neutral-100">
              <h3 className="font-bold text-neutral-950">Cancel — assign a substitute?</h3>
              <p className="text-sm text-neutral-500 mt-1">
                {cancelReview.batch_planners?.batches?.name || 'Batch'} — {cancelReview.batch_planners?.subjects?.name || 'Subject'} · {fmt(cancelReview.original_date)}{cancelReview.original_start_time && ` at ${cancelReview.original_start_time.slice(0, 5)}`}
              </p>
              <p className="text-xs text-neutral-400 mt-1">Faculty free at this slot (same centre) — assign one to <b>keep the class</b>, or just cancel it.</p>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {freeLoading ? (
                <p className="text-sm text-neutral-400 text-center py-6">Checking who&apos;s free…</p>
              ) : freeFac.length === 0 ? (
                <p className="text-sm text-neutral-500 text-center py-6">No faculty are free at this slot in this centre. You can still cancel below.</p>
              ) : (
                <div className="space-y-1.5">
                  {freeFac.map((f) => (
                    <div key={f.id} className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border ${f.teachesSubject ? 'bg-emerald-50/60 border-emerald-200' : 'bg-neutral-50 border-neutral-200'}`}>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-neutral-900 truncate">{f.full_name}</div>
                        <div className="text-[11px] text-neutral-500">{f.teachesSubject ? 'Teaches this subject · free' : 'Free at this slot'}</div>
                      </div>
                      <button onClick={() => assignSubstitute(cancelReview, f.id, f.full_name)} disabled={subBusy} className="shrink-0 h-8 px-3 bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Assign &amp; keep</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-neutral-100 flex gap-2">
              <button onClick={() => { const req = cancelReview; setCancelReview(null); if (req) approveRequest(req) }} disabled={subBusy} className="flex-1 h-10 px-4 bg-red-600 hover:bg-red-700 disabled:bg-neutral-300 text-white text-sm font-semibold rounded-lg">Just cancel (no substitute)</button>
              <button onClick={() => setCancelReview(null)} disabled={subBusy} className="h-10 px-4 border border-neutral-300 rounded-lg text-sm font-medium text-neutral-700">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
