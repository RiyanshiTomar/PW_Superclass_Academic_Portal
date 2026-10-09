import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser, hasRole } from '@/lib/auth'

const NAV = [
  { label: 'Dashboard', href: '/branch', icon: '🏫' },
  { label: 'Faculty Schedule View', href: '/faculty-schedule', icon: '👥' },
  { label: 'Students', href: '/branch/students', icon: '🎓' },
  { label: 'Schedule', href: '/branch/calendar', icon: '📅' },
  { label: 'Batch Scheduler', href: '/branch/batch-scheduler', icon: '🗂️' },
  { label: 'Tests', href: '/branch/tests', icon: '📝' },
  { label: 'Marks Entry', href: '/branch/marks-entry', icon: '✍️' },
  { label: 'Results', href: '/branch/results', icon: '📊' },
  { label: 'Student Overview', href: '/branch/student-overview', icon: '🧑‍🎓' },
  { label: 'Attendance', href: '/branch/attendance', icon: '🗓️' },
]

export default async function BranchLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="branch_head"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/branch"
      navItems={hasRole(appUser, 'centre_admin') ? [...NAV.slice(0, 5), { label: 'Faculty', href: '/branch/faculty', icon: '🧑‍🏫' }, ...NAV.slice(5)] : NAV}
    >
      {children}
    </PortalShell>
  )
}
