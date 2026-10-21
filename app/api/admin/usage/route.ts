import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DAY = /^\d{4}-\d{2}-\d{2}$/

// Data for the admin Usage Report: every portal user, their sign-ins, the
// pages they opened (per day) and the work they recorded, for a date range
// (India dates). Admin only. Uses the service key because the last sign-in
// time lives in Supabase Auth, which the browser can't read.
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: caller } = await supabase.from('app_users').select('roles, role').eq('email', user.email.toLowerCase()).maybeSingle()
  const roles: string[] = Array.isArray(caller?.roles) && caller.roles.length > 0 ? caller.roles : caller?.role ? [caller.role] : []
  if (!roles.includes('admin')) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? ''
  if (!DAY.test(from) || !DAY.test(to) || from > to) return NextResponse.json({ error: 'Pick a valid date range.' }, { status: 400 })
  const fromTs = `${from}T00:00:00+05:30`, toTs = `${to}T23:59:59.999+05:30`

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const [users, links, centres, usage, logins, audit, reqMade, reqReviewed, tests, planners, firstUse] = await Promise.all([
    fetchAll<{ id: string; full_name: string; email: string; role: string | null; roles: string[] | null; status: string | null; centre_id: string | null; auth_id: string | null }>((a, b) =>
      db.from('app_users').select('id, full_name, email, role, roles, status, centre_id, auth_id').order('id').range(a, b)),
    fetchAll<{ user_id: string; centre_id: string }>((a, b) => db.from('user_centres').select('user_id, centre_id').order('user_id').order('centre_id').range(a, b)),
    db.from('centres').select('id, name'),
    fetchAll<{ user_id: string; day: string; section: string; portal: string | null; hits: number; first_at: string; last_at: string }>((a, b) =>
      db.from('usage_daily').select('user_id, day, section, portal, hits, first_at, last_at').gte('day', from).lte('day', to).order('day').order('user_id').order('section').range(a, b)),
    fetchAll<{ user_id: string; at: string }>((a, b) => db.from('login_events').select('user_id, at').gte('at', fromTs).lte('at', toTs).order('at').range(a, b)),
    fetchAll<{ user_id: string | null; created_at: string }>((a, b) => db.from('audit_log').select('user_id, created_at').gte('created_at', fromTs).lte('created_at', toTs).order('created_at').range(a, b)),
    fetchAll<{ requested_by: string; created_at: string }>((a, b) => db.from('reschedule_requests').select('requested_by, created_at').gte('created_at', fromTs).lte('created_at', toTs).order('created_at').range(a, b)),
    fetchAll<{ reviewed_by: string | null; reviewed_at: string }>((a, b) => db.from('reschedule_requests').select('reviewed_by, reviewed_at').gte('reviewed_at', fromTs).lte('reviewed_at', toTs).order('reviewed_at').range(a, b)),
    fetchAll<{ created_by: string | null; created_at: string }>((a, b) => db.from('test_schedules').select('created_by, created_at').gte('created_at', fromTs).lte('created_at', toTs).order('created_at').range(a, b)),
    fetchAll<{ created_by: string | null; created_at: string }>((a, b) => db.from('planners').select('created_by, created_at').gte('created_at', fromTs).lte('created_at', toTs).order('created_at').range(a, b)),
    db.from('usage_daily').select('day').order('day').limit(1),
  ])
  const err = users.error ?? usage.error ?? logins.error
  if (err) {
    const missing = /usage_daily|login_events/.test(err)
    return NextResponse.json({ error: missing ? 'Usage tracking tables are missing — run scripts/migration-usage.sql in Supabase first.' : err }, { status: 500 })
  }

  // Last password sign-in from Supabase Auth (known even before tracking began).
  const lastSignIn = new Map<string, string | null>()
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) break
    for (const u of data.users) {
      lastSignIn.set(`id:${u.id}`, u.last_sign_in_at ?? null)
      if (u.email) lastSignIn.set(`email:${u.email.toLowerCase()}`, u.last_sign_in_at ?? null)
    }
    if (data.users.length < 1000) break
  }

  // Work recorded per user, by kind.
  const actions = new Map<string, Record<string, number>>()
  const add = (id: string | null | undefined, kind: string) => {
    if (!id) return
    const cur = actions.get(id) ?? {}
    cur[kind] = (cur[kind] ?? 0) + 1
    actions.set(id, cur)
  }
  for (const r of audit.data) add(r.user_id, 'Schedule changes')
  for (const r of reqMade.data) add(r.requested_by, 'Reschedule requests')
  for (const r of reqReviewed.data) add(r.reviewed_by, 'Requests reviewed')
  for (const r of tests.data) add(r.created_by, 'Tests scheduled')
  for (const r of planners.data) add(r.created_by, 'Planners created')

  const centreName = new Map((centres.data ?? []).map((c) => [c.id as string, c.name as string]))
  const userCentres = new Map<string, string[]>()
  for (const l of links.data) userCentres.set(l.user_id, [...(userCentres.get(l.user_id) ?? []), l.centre_id])

  return NextResponse.json({
    from, to,
    trackingSince: (firstUse.data?.[0]?.day as string | undefined) ?? null,
    users: users.data.map((u) => {
      const ids = userCentres.get(u.id) ?? (u.centre_id ? [u.centre_id] : [])
      return {
        id: u.id, name: u.full_name, email: u.email, status: u.status ?? 'active',
        roles: Array.isArray(u.roles) && u.roles.length ? u.roles : u.role ? [u.role] : [],
        centres: Array.from(new Set(ids)).map((id) => centreName.get(id)).filter(Boolean),
        lastSignIn: (u.auth_id ? lastSignIn.get(`id:${u.auth_id}`) : undefined) ?? lastSignIn.get(`email:${u.email?.toLowerCase()}`) ?? null,
        actions: actions.get(u.id) ?? {},
      }
    }),
    usage: usage.data,
    logins: logins.data,
  })
}
