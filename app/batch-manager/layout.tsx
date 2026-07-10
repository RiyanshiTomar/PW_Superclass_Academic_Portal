import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'Dashboard', href: '/batch-manager', icon: '📋' },
  { label: 'Attendance', href: '/batch-manager/attendance', icon: '🗓️' },
]

export default async function BatchManagerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="batch_manager"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/batch-manager"
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
