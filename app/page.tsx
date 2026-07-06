import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.email) {
    redirect('/login')
  }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role, roles, status')
    .eq('email', user.email.toLowerCase())
    .maybeSingle()

  if (!appUser || appUser.status === 'inactive') {
    redirect('/login?error=no_access')
  }

  const activeRoles = Array.isArray(appUser.roles) && appUser.roles.length > 0
    ? appUser.roles
    : appUser.role
    ? [appUser.role]
    : []

  if (activeRoles.length === 0) {
    redirect('/login?error=no_access')
  }

  if (activeRoles.length > 1) {
    redirect('/choose-role')
  }

  const roleRedirects: Record<string, string> = {
    admin: '/admin',
    central_team: '/central',
    faculty: '/faculty',
    branch_head: '/branch',
    batch_manager: '/batch-manager',
  }

  redirect(roleRedirects[activeRoles[0]] || '/login')
}
