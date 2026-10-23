// Shared for the Head (HOD) dashboards: who may see them, the service client,
// and how a batch's pace is judged.
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/** The signed-in user if they may open the Head dashboards (head or admin). */
export async function headCaller() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return null
  const { data } = await supabase.from('app_users').select('id, roles, role, status').eq('email', user.email.toLowerCase()).maybeSingle()
  const roles: string[] = Array.isArray(data?.roles) && data.roles.length ? data.roles : data?.role ? [data.role] : []
  if (!data || data.status === 'inactive' || !roles.some((r) => r === 'head' || r === 'admin')) return null
  return data
}

export const serviceDb = () =>
  createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

export const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

/** Pace = when the planner finishes the syllabus vs. the batch end date (the
 *  same rule as Central Hub's "Late by Xd" chip). Any day late = too slow;
 *  finishing more than max(15 days, 10% of the batch) early = too fast. */
export const fastMarginDays = (durationDays: number) => Math.max(15, Math.round(durationDays * 0.1))

export type PaceStatus = 'Too fast' | 'On track' | 'Too slow' | 'Not started' | 'Ended' | 'No planner'

export function paceStatus(p: { total: number; lateDays: number | null; durationDays: number; started: boolean; ended: boolean }): PaceStatus {
  if (!p.total || p.lateDays == null) return 'No planner'
  if (!p.started) return 'Not started'
  if (p.ended) return 'Ended'
  if (p.lateDays > 0) return 'Too slow'
  if (-p.lateDays > fastMarginDays(p.durationDays)) return 'Too fast'
  return 'On track'
}
