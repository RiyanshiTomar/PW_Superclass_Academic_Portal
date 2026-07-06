import type { SupabaseClient } from '@supabase/supabase-js'

export type UserCentre = {
  centre_id: string
  is_primary: boolean
  centres?: { id: string; name: string }
}

export type AppUser = {
  id: string
  full_name: string
  role?: string
  roles?: string[]
  centre_id: string | null
  user_centres?: UserCentre[]
}

export async function getAppUser(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null }
): Promise<AppUser | null> {
  const fields = 'id, full_name, role, roles, centre_id, user_centres(centre_id, is_primary, centres(id, name))'

  // Try by auth_id first
  const { data: byAuth } = await supabase
    .from('app_users')
    .select(fields)
    .eq('auth_id', user.id)
    .maybeSingle()

  if (byAuth) return byAuth as unknown as AppUser

  if (!user.email) return null

  // Fallback: match by email
  const { data: byEmail } = await supabase
    .from('app_users')
    .select(fields)
    .eq('email', user.email.toLowerCase())
    .maybeSingle()

  if (byEmail) {
    // Auto-link auth_id for future fast lookups
    await supabase
      .from('app_users')
      .update({ auth_id: user.id })
      .eq('id', (byEmail as unknown as AppUser).id)
  }

  return (byEmail as unknown as AppUser) ?? null
}

/** Get all centre IDs a user belongs to */
export function getUserCentreIds(appUser: AppUser | null): string[] {
  if (!appUser) return []
  if (appUser.user_centres && appUser.user_centres.length > 0) {
    return appUser.user_centres.map((uc) => uc.centre_id)
  }
  // Fallback to legacy centre_id field
  return appUser.centre_id ? [appUser.centre_id] : []
}

/** Check if a user has a specific role */
export function hasRole(appUser: AppUser | null, role: string): boolean {
  if (!appUser) return false
  if (Array.isArray(appUser.roles) && appUser.roles.includes(role)) return true
  return appUser.role === role
}
