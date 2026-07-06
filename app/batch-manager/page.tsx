'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, PageHeader, Alert } from '@/components/PortalShell'
import { DAYS, formatTime } from '@/lib/utils'

type Batch = {
  id: string
  name: string
  program_id: string
  centre_id: string
  start_date: string
  end_date: string
  status: string
  programs?: { name: string }
  centres?: { name: string }
}

type Schedule = {
  id: string
  day_of_week: number
  start_time: string
  end_time: string
  faculty_id: string
  batch_id: string
  app_users?: { full_name: string }
}

type BatchManagerDashboardProps = {
  // empty for now
}

export default function BatchManagerDashboard() {
  const supabase = createClient()
  const [batches, setBatches] = useState<Batch[]>([])
  const [schedules, setSchedules] = useState<Record<string, Schedule[]>>({})
  const [loading, setLoading] = useState(true)
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null)
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null)
  const [newDay, setNewDay] = useState(0)
  const [newStartTime, setNewStartTime] = useState('')
  const [newEndTime, setNewEndTime] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    async function load() {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) return

      // Find app_user
      const { data: appUser } = await supabase
        .from('app_users')
        .select('id')
        .eq('email', user.email.toLowerCase())
        .maybeSingle()

      if (!appUser) return

      // Load batches managed by this user
      const { data: batchData } = await supabase
        .from('batches')
        .select('*, programs(name), centres(name)')
        .eq('batch_manager_id', appUser.id)
        .order('created_at', { ascending: false })

      if (batchData) setBatches(batchData as unknown as Batch[])
      setLoading(false)
    }
    load()
  }, [])

  const loadSchedule = async (batchId: string) => {
    if (schedules[batchId]) {
      setExpandedBatch(expandedBatch === batchId ? null : batchId)
      return
    }

    const { data } = await supabase
      .from('batch_schedules')
      .select('id, day_of_week, start_time, end_time, faculty_id, batch_id, app_users(full_name)')
      .eq('batch_id', batchId)
      .order('day_of_week')

    if (data) {
      setSchedules((prev) => ({ ...prev, [batchId]: data as unknown as Schedule[] }))
    }
    setExpandedBatch(batchId)
  }

  function openRequestModal(schedule: Schedule) {
    setSelectedSchedule(schedule)
    setNewDay(schedule.day_of_week)
    setNewStartTime(schedule.start_time.slice(0, 5))
    setNewEndTime(schedule.end_time.slice(0, 5))
    setReason('')
    setShowRequestModal(true)
  }

  async function submitScheduleRequest() {
    if (!selectedSchedule || !reason.trim()) return

    setSubmitting(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSubmitting(false); return }

    const { data: appUser } = await supabase
      .from('app_users')
      .select('id')
      .eq('email', user.email!.toLowerCase())
      .maybeSingle()

    if (!appUser) { setSubmitting(false); return }

    const { error } = await supabase.from('reschedule_requests').insert({
      schedule_id: selectedSchedule.id,
      requested_by: appUser.id,
      request_type: 'schedule',
      original_date: null,
      original_start_time: selectedSchedule.start_time,
      original_end_time: selectedSchedule.end_time,
      requested_date: null,
      requested_start_time: newStartTime,
      requested_end_time: newEndTime,
      reason: reason.trim(),
      status: 'pending',
    })

    if (error) {
      alert('Failed to submit request: ' + error.message)
    } else {
      alert('Schedule change request submitted!')
      setShowRequestModal(false)
    }
    setSubmitting(false)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Batch Manager Dashboard"
        description="View the batches you manage, their schedules and planned lectures."
      />

      {loading ? (
        <div className="py-16 text-center text-neutral-400">Loading your batches...</div>
      ) : batches.length === 0 ? (
        <div className="bg-white rounded-xl p-8 border border-neutral-200 text-center">
          <p className="text-neutral-600 font-medium mb-2">No batches assigned to you yet</p>
          <p className="text-sm text-neutral-400">
            Once the Central Team creates a batch and assigns it to you, it will appear here.<br/>
            You can then view the schedule and request changes from this page.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {batches.map((b) => (
            <Card key={b.id} className="p-6">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-bold text-neutral-950 text-lg">{b.name}</h3>
                  <p className="text-sm text-neutral-500">
                    {(b.programs as unknown as { name: string })?.name} &middot; {(b.centres as unknown as { name: string })?.name}
                  </p>
                  <p className="text-xs text-neutral-400 mt-1">
                    {new Date(b.start_date).toLocaleDateString()} – {new Date(b.end_date).toLocaleDateString()}
                  </p>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">
                  {b.status}
                </span>
              </div>

              <button
                onClick={() => loadSchedule(b.id)}
                className="text-sm font-medium text-neutral-700 underline underline-offset-2 hover:text-neutral-950"
              >
                {expandedBatch === b.id ? 'Hide Schedule' : 'View Schedule'}
              </button>

              {expandedBatch === b.id && schedules[b.id] && (
                <div className="mt-4 border-t border-neutral-100 pt-4">
                  {schedules[b.id].length === 0 ? (
                    <p className="text-sm text-neutral-400">No schedule configured yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-neutral-500 uppercase tracking-wider">
                            <th className="text-left py-2 pr-4">Day</th>
                            <th className="text-left py-2 pr-4">Time</th>
                            <th className="text-left py-2 pr-4">Faculty</th>
                            <th className="text-left py-2">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-50">
                          {schedules[b.id].map((s, i) => (
                            <tr key={i}>
                              <td className="py-2 pr-4 font-medium">{DAYS[s.day_of_week]}</td>
                              <td className="py-2 pr-4 text-neutral-600">{formatTime(s.start_time)} – {formatTime(s.end_time)}</td>
                              <td className="py-2 pr-4 text-neutral-600">{(s.app_users as unknown as { full_name: string })?.full_name || '—'}</td>
                              <td className="py-2">
                                <button
                                  onClick={() => openRequestModal(s)}
                                  className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-medium rounded"
                                >
                                  Request Change
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {showRequestModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold text-neutral-900 mb-4">Request Schedule Change</h3>
            <p className="text-sm text-neutral-600 mb-4">
              Current: {DAYS[selectedSchedule.day_of_week]} {formatTime(selectedSchedule.start_time)} – {formatTime(selectedSchedule.end_time)}
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">New Day</label>
                <select
                  value={newDay}
                  onChange={(e) => setNewDay(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                >
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">New Start</label>
                  <input
                    type="time"
                    value={newStartTime}
                    onChange={(e) => setNewStartTime(e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">New End</label>
                  <input
                    type="time"
                    value={newEndTime}
                    onChange={(e) => setNewEndTime(e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Reason</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                  placeholder="Why do you need to change the schedule?"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setShowRequestModal(false)}
                className="flex-1 px-4 py-2 border border-neutral-300 text-neutral-700 rounded-lg text-sm font-medium hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                onClick={submitScheduleRequest}
                disabled={submitting || !reason.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-300 text-white rounded-lg text-sm font-semibold"
              >
                {submitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
