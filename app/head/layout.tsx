import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser, hasRole } from '@/lib/auth'

const NAV = [
  { label: 'Batch Pace', href: '/head', icon: '📈' },
  { label: 'Faculty Usage', href: '/head/faculty', icon: '👩‍🏫' },
]

export default async function HeadLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)
  if (!hasRole(appUser, 'head') && !hasRole(appUser, 'admin')) redirect('/')

  return (
    <PortalShell role="head" fullName={appUser?.full_name ?? user.email ?? ''} homeHref="/head" navItems={NAV}>
      {children}
    </PortalShell>
  )
}
