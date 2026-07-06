'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, PageHeader, Alert } from '@/components/PortalShell'
import { DAYS, formatTime } from '@/lib/utils'

type Batch = {
  id: string
  name: string
  status: string
  start_date: string
  end_date: string
  programs?: { name: string }
  batch_manager?: { full_name: string }
}

type Faculty = {
  id: string
  full_name: string
  email: string
  faculty_type: string | null
}

type Schedule = {
  day_of_week: number
  start_time: string
  end_time: string
  app_users?: { full_name: string }
}

export default function BranchHome() {
  const supabase = createClient()
  const [centreName, setCentreName] = useState('')
  const [batches, setBatches] = useState<Batch[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null)
  const [schedules, setSchedules] = useState<Record<string, Schedule[]>>({})

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) return

      // Get app_user and their centre(s)
      const { data: appUser } = await supabase
        .from('app_users')
        .select('id, full_name, centre_id')
        .eq('email', user.email.toLowerCase())
        .maybeSingle()

      if (!appUser) { setLoading(false); return }

      // Get centre from user_centres or fallback
      let centreId = appUser.centre_id
      const { data: uc } = await supabase
        .from('user_centres')
        .select('centre_id, centres(name)')
        .eq('user_id', appUser.id)
        .eq('is_primary', true)
        .maybeSingle()

      if (uc) {
        centreId = uc.centre_id
        setCentreName((uc.centres as unknown as { name: string })?.name || '')
      } else if (centreId) {
        const { data: c } = await supabase.from('centres').select('name').eq('id', centreId).single()
        if (c) setCentreName(c.name)
      }

      if (!centreId) { setLoading(false); return }

      // Load batches for this centre
      const { data: batchData } = await supabase
        .from('batches')
        .select('id, name, status, start_date, end_date, programs(name), batch_manager_id')
        .eq('centre_id', centreId)
        .order('created_at', { ascending: false })

      if (batchData) setBatches(batchData as unknown as Batch[])

      // Load faculty for this centre (via user_centres)
      const { data: ucFaculty } = await supabase
        .from('user_centres')
        .select('user_id')
        .eq('centre_id', centreId)

      if (ucFaculty && ucFaculty.length > 0) {
        const facultyIds = ucFaculty.map((uc) => uc.user_id)
        const { data: facData } = await supabase
          .from('app_users')
          .select('id, full_name, email, faculty_type')
          .in('id', facultyIds)
          .or('role.eq.faculty,roles.cs.{faculty}')
          .eq('status', 'active')
          .order('full_name')

        if (facData) setFaculty(facData as unknown as Faculty[])
      }

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
      .select('day_of_week, start_time, end_time, app_users(full_name)')
      .eq('batch_id', batchId)
      .order('day_of_week')

    if (data) setSchedules((prev) => ({ ...prev, [batchId]: data as unknown as Schedule[] }))
    setExpandedBatch(batchId)
  }

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Branch Head Dashboard"
        description={centreName ? `Centre: ${centreName} — monitor your batches and faculty.` : 'Your centre overview.'}
      />

      {loading ? (
        <div className="py-16 text-center text-neutral-400">Loading centre data...</div>
      ) : (
        <div className="space-y-10">
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-5 text-center">
              <div className="text-3xl font-black text-neutral-950">{batches.length}</div>
              <div className="text-xs text-neutral-500 mt-1">Total Batches</div>
            </Card>
            <Card className="p-5 text-center">
              <div className="text-3xl font-black text-neutral-950">{batches.filter((b) => b.status === 'active').length}</div>
              <div className="text-xs text-neutral-500 mt-1">Active Batches</div>
            </Card>
            <Card className="p-5 text-center">
              <div className="text-3xl font-black text-neutral-950">{faculty.length}</div>
              <div className="text-xs text-neutral-500 mt-1">Faculty Members</div>
            </Card>
            <Card className="p-5 text-center">
              <div className="text-3xl font-black text-neutral-950">{faculty.filter((f) => f.faculty_type === 'Permanent').length}</div>
              <div className="text-xs text-neutral-500 mt-1">Permanent Faculty</div>
            </Card>
          </div>

          {/* Batches */}
          <section>
            <h2 className="text-lg font-bold text-neutral-950 mb-4">Batches</h2>
            {batches.length === 0 ? (
              <Alert type="info">No batches at this centre yet.</Alert>
            ) : (
              <div className="space-y-3">
                {batches.map((b) => (
                  <Card key={b.id} className="p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-bold text-neutral-950">{b.name}</h3>
                        <p className="text-sm text-neutral-500">{(b.programs as unknown as { name: string })?.name}</p>
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
                      className="mt-3 text-sm font-medium text-neutral-700 underline underline-offset-2 hover:text-neutral-950"
                    >
                      {expandedBatch === b.id ? 'Hide Schedule' : 'View Schedule'}
                    </button>

                    {expandedBatch === b.id && schedules[b.id] && (
                      <div className="mt-3 border-t border-neutral-100 pt-3">
                        {schedules[b.id].length === 0 ? (
                          <p className="text-sm text-neutral-400">No schedule configured.</p>
                        ) : (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {schedules[b.id].map((s, i) => (
                              <div key={i} className="text-xs p-2 bg-neutral-50 rounded-lg">
                                <span className="font-semibold">{DAYS[s.day_of_week]}</span>{' '}
                                {formatTime(s.start_time)}–{formatTime(s.end_time)}
                                <div className="text-neutral-500">{(s.app_users as unknown as { full_name: string })?.full_name || '—'}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/* Faculty */}
          <section>
            <h2 className="text-lg font-bold text-neutral-950 mb-4">Faculty at Your Centre</h2>
            {faculty.length === 0 ? (
              <Alert type="info">No faculty linked to this centre.</Alert>
            ) : (
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-semibold">Name</th>
                      <th className="text-left px-4 py-3 font-semibold">Email</th>
                      <th className="text-left px-4 py-3 font-semibold">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {faculty.map((f) => (
                      <tr key={f.id}>
                        <td className="px-4 py-3 font-medium text-neutral-950">{f.full_name}</td>
                        <td className="px-4 py-3 text-neutral-600">{f.email}</td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                            f.faculty_type === 'Permanent' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}>
                            {f.faculty_type || 'N/A'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  )
}