import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAppUser, hasRole } from '@/lib/auth'
import CentreFaculty from '@/components/CentreFaculty'

// Only branch heads with the extra 'centre_admin' permission may add faculty.
export default async function BranchFacultyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const appUser = await getAppUser(supabase, user)
  if (!hasRole(appUser, 'centre_admin')) redirect('/branch')
  return <CentreFaculty />
}
