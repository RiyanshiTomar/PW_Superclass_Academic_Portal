import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'My Batches', href: '/faculty', icon: '📚' },
  { label: 'My Planners', href: '/faculty/planners', icon: '🗂️' },
  { label: 'My Tests', href: '/faculty/tests', icon: '📝' },
  { label: 'Results', href: '/faculty/results', icon: '📊' },
  { label: 'Calendar', href: '/faculty/calendar', icon: '📅' },
]

export default async function FacultyLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="faculty"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/faculty"
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
