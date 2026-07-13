import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'Dashboard', href: '/admin' },
  { label: 'Centres', href: '/admin/centres' },
  { label: 'Programs', href: '/admin/programs' },
  { label: 'Syllabus', href: '/admin/syllabus' },
  { label: 'Faculty', href: '/admin/faculty' },
  { label: 'Central Team', href: '/admin/central-team' },
  { label: 'Batch Managers', href: '/admin/batch-managers' },
  { label: 'Branch Heads', href: '/admin/branch-heads' },
  { label: 'Credentials', href: '/admin/credentials' },
  { label: 'Attendance', href: '/admin/attendance' },
  { label: 'Audit Log', href: '/admin/audit-log' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="admin"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/admin"
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
