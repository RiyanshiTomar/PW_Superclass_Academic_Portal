import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncStudents } from '@/lib/student-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// "Sync now" from the Students page — same sync as the nightly cron, but
// triggered by a signed-in Central Team / Admin / Branch Head user.
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: caller } = await supabase
    .from('app_users')
    .select('roles, role')
    .eq('email', user.email.toLowerCase())
    .maybeSingle()
  const roles: string[] = Array.isArray(caller?.roles) && caller.roles.length > 0 ? caller.roles : caller?.role ? [caller.role] : []
  if (!roles.some((r) => r === 'central_team' || r === 'admin' || r === 'branch_head')) return NextResponse.json({ error: 'Central Team, Admin or Branch Head only' }, { status: 403 })

  try {
    const rawAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (!rawAccount) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured.')
    const summary = await syncStudents({ serviceAccount: JSON.parse(rawAccount), supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, sheetId: process.env.STUDENTS_SHEET_ID })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('Manual student sync failed', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Student sync failed.' }, { status: 500 })
  }
}
