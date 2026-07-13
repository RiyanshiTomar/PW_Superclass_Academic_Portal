import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'Dashboard', href: '/branch', icon: '🏫' },
  { label: 'Students', href: '/branch/students', icon: '🎓' },
  { label: 'Tests', href: '/branch/tests', icon: '📝' },
  { label: 'Marks Entry', href: '/branch/marks-entry', icon: '✍️' },
  { label: 'Results', href: '/branch/results', icon: '📊' },
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
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
