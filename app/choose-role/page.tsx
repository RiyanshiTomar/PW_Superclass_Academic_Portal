import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

const roleRedirects: Record<string, string> = {
  admin: '/admin',
  central_team: '/central',
  faculty: '/faculty',
  branch_head: '/branch',
  batch_manager: '/batch-manager',
}

const roleLabels: Record<string, string> = {
  admin: 'Admin Portal',
  central_team: 'Central Team Portal',
  faculty: 'Faculty Portal',
  branch_head: 'Branch Head Portal',
  batch_manager: 'Batch Manager Portal',
}

const roleDescriptions: Record<string, string> = {
  admin: 'Manage centres, programs, faculty, and portal users.',
  central_team: 'Schedule batches, plan lectures, and assign work.',
  faculty: 'View your teaching schedule and planned lectures.',
  branch_head: 'Manage your centre and monitor batch activity.',
  batch_manager: 'Monitor batches you manage and view planned lectures.',
}

export default async function ChooseRolePage() {
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

  if (activeRoles.length === 1) {
    redirect(roleRedirects[activeRoles[0]] || '/login')
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-neutral-950">Choose your portal</h1>
          <p className="mt-3 text-sm text-neutral-500">
            You have access to multiple roles. Select the portal you want to use for this session.
          </p>
        </div>

        <div className="grid gap-4">
          {activeRoles.map((role) => (
            <a
              key={role}
              href={roleRedirects[role] || '/'}
              className="block rounded-3xl border border-neutral-200 bg-neutral-50 px-6 py-5 transition hover:border-neutral-950 hover:bg-neutral-100"
            >
              <p className="text-xl font-semibold text-neutral-950">{roleLabels[role] || role}</p>
              <p className="mt-2 text-sm text-neutral-500">{roleDescriptions[role] || 'Open this portal.'}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
