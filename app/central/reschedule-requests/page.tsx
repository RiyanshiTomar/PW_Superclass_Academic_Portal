'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { cascadeReschedule, cascadeCancel, addExtraLecture } from '@/lib/planners'
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
  app_users?: { full_name: string }
  batch_planners?: {
    topic_name: string
    batches?: { name: string }
    subjects?: { name: string }
  }
}

function isCancellation(req: RescheduleRequest) {
  return req.request_type === 'cancel' || (req.request_type !== 'extra' && !req.requested_date)
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
        batch_planners(topic_name, batches(name), subjects(name))
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

    // Apply the change to the planner first (cascade), so we don't mark it
    // approved if the shift would create an overlap.
    if (req.planner_id) {
      let result: { ok: boolean; error?: string }
      if (isExtra(req)) {
        const dur = req.requested_start_time && req.requested_end_time
          ? toMinutes(req.requested_end_time.slice(0, 5)) - toMinutes(req.requested_start_time.slice(0, 5))
          : undefined
        result = await addExtraLecture(supabase, req.planner_id, req.requested_date!, req.requested_start_time ?? null, dur && dur > 0 ? dur : undefined, { topic_name: req.extra_topic ?? null, chapter: req.extra_chapter ?? null })
      } else if (isCancellation(req)) {
        result = await cascadeCancel(supabase, req.planner_id)
      } else {
        result = await cascadeReschedule(supabase, req.planner_id, req.requested_date!, req.requested_start_time ?? null)
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
    setMessage({ type: 'success', text: isExtra(req) ? 'Approved — extra class added to the faculty calendar.' : isCancellation(req) ? 'Cancelled — later lectures shifted up.' : 'Approved — planner updated and subsequent lectures shifted.' })
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
            const cancel = isCancellation(req)
            const extra = isExtra(req)
            return (
              <Card key={req.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-neutral-900">
                        {req.batch_planners?.batches?.name || 'Batch'} — {req.batch_planners?.subjects?.name || 'Subject'}
                      </p>
                      {cancel && <span className="text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 px-2 py-0.5 rounded-full">Cancellation</span>}
                      {extra && <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">Extra Class</span>}
                    </div>
                    <p className="text-xs text-neutral-500 mt-1">Requested by: {req.app_users?.full_name || 'Unknown'}</p>
                    {req.batch_planners?.topic_name && <p className="text-xs text-neutral-500">Topic: {req.batch_planners.topic_name}</p>}
                    <p className="text-xs text-neutral-500 mt-1">
                      {cancel ? (
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
                        <button onClick={() => approveRequest(req)} disabled={reviewingId === req.id} className="h-8 px-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-300 text-white text-xs font-semibold rounded-lg">Approve</button>
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
    </div>
  )
}
