import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'Central Hub', href: '/central', icon: '🎛️' },
  { label: 'Reschedule Requests', href: '/central/reschedule-requests', icon: '🔁' },
]

export default async function CentralLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="central_team"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/central"
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
