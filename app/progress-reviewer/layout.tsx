import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import { getAppUser } from '@/lib/auth'

const NAV = [
  { label: 'Batch Progress', href: '/progress-reviewer', icon: '📊' },
]

export default async function ProgressReviewerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)

  return (
    <PortalShell
      role="progress_reviewer"
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref="/progress-reviewer"
      navItems={NAV}
    >
      {children}
    </PortalShell>
  )
}
