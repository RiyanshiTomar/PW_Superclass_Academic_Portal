import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import FacultyScheduleView from '@/components/FacultyScheduleView'

export default async function FacultySchedulePage() {
  const supabase = await createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRole } = await supabase
    .from('app_users')
    .select('role, roles')
    .eq('email', user.email?.toLowerCase())
    .single()

  // Check if user has admin, central, or branch_head access
  const hasAccess = userRole && (
    userRole.role === 'admin' ||
    userRole.role === 'central_team' ||
    userRole.role === 'branch_head' ||
    (userRole.roles && (
      userRole.roles.includes('admin') ||
      userRole.roles.includes('central_team') ||
      userRole.roles.includes('branch_head')
    ))
  )

  if (!hasAccess) {
    redirect('/')
  }

  return <FacultyScheduleView />
}