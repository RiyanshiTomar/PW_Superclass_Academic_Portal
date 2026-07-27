import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PortalShell from '@/components/PortalShell'
import RouteScope from '@/components/RouteScope'
import { getAppUser, hasRole } from '@/lib/auth'

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

// A syllabus-only editor sees just the Syllabus page.
const SYLLABUS_NAV = [{ label: 'Syllabus', href: '/admin/syllabus' }]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await getAppUser(supabase, user)
  const isAdmin = hasRole(appUser, 'admin')
  const isSyllabusEditor = hasRole(appUser, 'syllabus_editor')

  // Only full admins or scoped syllabus editors belong in the Admin portal.
  if (!isAdmin && !isSyllabusEditor) redirect('/')

  const syllabusOnly = isSyllabusEditor && !isAdmin

  return (
    <PortalShell
      role={syllabusOnly ? 'syllabus_editor' : 'admin'}
      fullName={appUser?.full_name ?? user.email ?? ''}
      homeHref={syllabusOnly ? '/admin/syllabus' : '/admin'}
      navItems={syllabusOnly ? SYLLABUS_NAV : NAV}
    >
      {syllabusOnly && <RouteScope allow="/admin/syllabus" redirectTo="/admin/syllabus" />}
      {children}
    </PortalShell>
  )
}
