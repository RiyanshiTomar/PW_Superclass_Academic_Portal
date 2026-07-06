'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, DashboardGrid, PageHeader } from '@/components/PortalShell'

export default function AdminHome() {
  const [stats, setStats] = useState({ centres: 0, programs: 0, faculty: 0, batches: 0, users: 0 })

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const [c, p, f, b, u] = await Promise.all([
        supabase.from('centres').select('id', { count: 'exact', head: true }),
        supabase.from('programs').select('id', { count: 'exact', head: true }),
        supabase.from('app_users').select('id', { count: 'exact', head: true }).or('role.eq.faculty,roles.cs.{faculty}'),
        supabase.from('batches').select('id', { count: 'exact', head: true }),
        supabase.from('app_users').select('id', { count: 'exact', head: true }),
      ])
      setStats({
        centres: c.count || 0,
        programs: p.count || 0,
        faculty: f.count || 0,
        batches: b.count || 0,
        users: u.count || 0,
      })
    }
    load()
  }, [])

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Admin Dashboard"
        description="Manage centres, programs, faculty, and all portal users."
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
        <Card className="p-5 text-center">
          <div className="text-3xl font-black text-neutral-950">{stats.centres}</div>
          <div className="text-xs text-neutral-500 mt-1">Centres</div>
        </Card>
        <Card className="p-5 text-center">
          <div className="text-3xl font-black text-neutral-950">{stats.programs}</div>
          <div className="text-xs text-neutral-500 mt-1">Programs</div>
        </Card>
        <Card className="p-5 text-center">
          <div className="text-3xl font-black text-neutral-950">{stats.faculty}</div>
          <div className="text-xs text-neutral-500 mt-1">Faculty</div>
        </Card>
        <Card className="p-5 text-center">
          <div className="text-3xl font-black text-neutral-950">{stats.batches}</div>
          <div className="text-xs text-neutral-500 mt-1">Batches</div>
        </Card>
        <Card className="p-5 text-center">
          <div className="text-3xl font-black text-neutral-950">{stats.users}</div>
          <div className="text-xs text-neutral-500 mt-1">Total Users</div>
        </Card>
      </div>

      <DashboardGrid
        items={[
          { title: 'Manage Centres', desc: 'Add, edit centres and assign branch heads', href: '/admin/centres' },
          { title: 'Manage Programs', desc: 'Add programs and subjects', href: '/admin/programs' },
          { title: 'Manage Faculty', desc: 'Add, edit, deactivate faculty accounts', href: '/admin/faculty' },
          { title: 'Central Team', desc: 'Add or remove central team members', href: '/admin/central-team' },
          { title: 'Branch Heads', desc: 'Assign branch heads to centres', href: '/admin/branch-heads' },
          { title: 'Batch Managers', desc: 'Manage batch managers across centres', href: '/admin/batch-managers' },
          { title: 'Audit Log', desc: 'View all system activity', href: '/admin/audit-log' },
        ]}
      />
    </div>
  )
}
