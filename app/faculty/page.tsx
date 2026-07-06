'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { minutesToHours } from '@/lib/utils'
import { Card, PageHeader } from '@/components/PortalShell'
import CountUp from '@/components/CountUp'

type Row = {
  batch_id: string
  planned_date: string
  duration_minutes: number
  stage: string
  batches: { name: string; centres: { name: string } | { name: string }[] | null } | { name: string; centres: { name: string } | { name: string }[] | null }[] | null
}

type BatchStat = {
  batchId: string
  batchName: string
  centreName: string
  total: number
  completed: number
  completedMinutes: number
  pendingMinutes: number
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

export default function FacultyHome() {
  const [name, setName] = useState('')
  const [stats, setStats] = useState<BatchStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      const appUser = await getAppUser(supabase, user)
      if (!appUser) { setLoading(false); return }
      setName(appUser.full_name)

      const today = new Date().toISOString().split('T')[0]
      const { data } = await supabase
        .from('batch_planners')
        .select('batch_id, planned_date, duration_minutes, stage, batches(name, centres(name))')
        .eq('faculty_id', appUser.id)
        .in('stage', ['Faculty Assigned', 'Confirmed'])
        .order('planned_date', { ascending: true })

      const byBatch = new Map<string, BatchStat>()
      for (const r of (data ?? []) as unknown as Row[]) {
        const batch = one(r.batches)
        const centre = one(batch?.centres)
        if (!byBatch.has(r.batch_id)) {
          byBatch.set(r.batch_id, {
            batchId: r.batch_id,
            batchName: batch?.name ?? 'Batch',
            centreName: centre?.name ?? '—',
            total: 0,
            completed: 0,
            completedMinutes: 0,
            pendingMinutes: 0,
          })
        }
        const s = byBatch.get(r.batch_id)!
        s.total += 1
        if (r.planned_date < today) {
          s.completed += 1
          s.completedMinutes += r.duration_minutes
        } else {
          s.pendingMinutes += r.duration_minutes
        }
      }
      setStats(Array.from(byBatch.values()))
      setLoading(false)
    }
    load()
  }, [])

  const totalCompleted = stats.reduce((a, s) => a + s.completedMinutes, 0)
  const totalPending = stats.reduce((a, s) => a + s.pendingMinutes, 0)

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="My Batches"
        description={name ? `Welcome back, ${name}. Track your teaching hours across batches.` : 'Track your teaching hours across batches.'}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
        <div className="animate-pop hover-lift rounded-2xl p-5 border border-violet-100 bg-gradient-to-br from-violet-50 to-white shadow-sm hover:shadow-lg hover:shadow-violet-500/10" style={{ animationDelay: '0ms' }}>
          <CountUp to={stats.length} className="text-3xl font-black text-violet-600" />
          <div className="text-xs font-medium text-violet-900/60 mt-1">📚 Active Batches</div>
        </div>
        <div className="animate-pop hover-lift rounded-2xl p-5 border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white shadow-sm hover:shadow-lg hover:shadow-emerald-500/10" style={{ animationDelay: '90ms' }}>
          <CountUp to={totalCompleted} format={(v) => minutesToHours(Math.round(v))} className="text-3xl font-black text-emerald-600" />
          <div className="text-xs font-medium text-emerald-900/60 mt-1">✓ Hours Completed</div>
        </div>
        <div className="animate-pop hover-lift rounded-2xl p-5 border border-amber-100 bg-gradient-to-br from-amber-50 to-white shadow-sm hover:shadow-lg hover:shadow-amber-500/10" style={{ animationDelay: '180ms' }}>
          <CountUp to={totalPending} format={(v) => minutesToHours(Math.round(v))} className="text-3xl font-black text-amber-600" />
          <div className="text-xs font-medium text-amber-900/60 mt-1">⏳ Hours Pending</div>
        </div>
      </div>

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : stats.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-neutral-600 font-medium mb-1">No assigned batches yet</p>
          <p className="text-sm text-neutral-400">Once the Central Team assigns a planner to you, your batches and hours appear here.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {stats.map((s) => {
            const totalMin = s.completedMinutes + s.pendingMinutes
            const pct = totalMin > 0 ? Math.round((s.completedMinutes / totalMin) * 100) : 0
            return (
              <Card key={s.batchId} className="p-6">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-bold text-neutral-950">{s.batchName}</h3>
                    <p className="text-xs text-neutral-500">{s.centreName}</p>
                  </div>
                  <span className="text-xs font-medium text-neutral-600">{s.completed}/{s.total} classes</span>
                </div>
                <div className="h-2.5 rounded-full bg-neutral-100 overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-emerald-700 font-medium">{minutesToHours(s.completedMinutes)} done</span>
                  <span className="text-violet-700 font-medium">{minutesToHours(s.pendingMinutes)} pending</span>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
