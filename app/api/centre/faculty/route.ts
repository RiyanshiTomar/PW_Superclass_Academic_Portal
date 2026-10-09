import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A branch head with the 'centre_admin' permission adds a NEW faculty member
// to their own centre (optionally with a login). It can never touch an
// existing account — that stays with the Admin portal.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: caller } = await supabase.from('app_users').select('id, role, roles').eq('email', user.email.toLowerCase()).maybeSingle()
  const roles: string[] = Array.isArray(caller?.roles) && caller.roles.length > 0 ? caller.roles : caller?.role ? [caller.role] : []
  if (!caller || !roles.includes('centre_admin')) return NextResponse.json({ error: 'You don’t have permission to add faculty.' }, { status: 403 })

  const body = (await request.json()) as {
    full_name?: string; email?: string; phone?: string; faculty_type?: string
    centre_id?: string; subject_ids?: string[]; password?: string
  }
  const fullName = (body.full_name ?? '').trim()
  const email = (body.email ?? '').trim().toLowerCase()
  const centreId = body.centre_id ?? ''
  if (!fullName || !email || !centreId) return NextResponse.json({ error: 'Name, email and centre are required.' }, { status: 400 })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: 'Enter a valid email.' }, { status: 400 })
  if (body.password && body.password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })

  // The centre must be one the caller heads / belongs to.
  const [{ data: uc }, { data: head }] = await Promise.all([
    supabase.from('user_centres').select('centre_id').eq('user_id', caller.id),
    supabase.from('centres').select('id').eq('branch_head_id', caller.id),
  ])
  const myCentres = new Set([...(uc ?? []).map((r) => r.centre_id as string), ...(head ?? []).map((r) => r.id as string)])
  if (!myCentres.has(centreId)) return NextResponse.json({ error: 'You can only add faculty to your own centre.' }, { status: 403 })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return NextResponse.json({ error: 'Server is not configured.' }, { status: 500 })
  const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: existing } = await admin.from('app_users').select('id').eq('email', email).maybeSingle()
  if (existing) return NextResponse.json({ error: 'A user with this email already exists. Ask the Admin to add the faculty role / centre to that account.' }, { status: 409 })

  const { data: created, error: insErr } = await admin.from('app_users').insert({
    full_name: fullName, email, phone: body.phone?.trim() || null, role: 'faculty', roles: ['faculty'],
    faculty_type: body.faculty_type === 'Hourly/Contract' ? 'Hourly/Contract' : 'Permanent',
    centre_id: centreId, status: 'active',
  }).select('id').single()
  if (insErr || !created) return NextResponse.json({ error: `Could not add faculty: ${insErr?.message ?? 'unknown error'}` }, { status: 500 })

  const { error: ucErr } = await admin.from('user_centres').insert({ user_id: created.id, centre_id: centreId, is_primary: true })
  if (ucErr) return NextResponse.json({ error: `Faculty added, but linking to the centre failed: ${ucErr.message}` }, { status: 500 })
  const subjects = Array.from(new Set(body.subject_ids ?? [])).filter(Boolean)
  if (subjects.length) {
    const { error } = await admin.from('faculty_subjects').insert(subjects.map((subject_id) => ({ faculty_id: created.id, subject_id })))
    if (error) return NextResponse.json({ error: `Faculty added, but saving subjects failed: ${error.message}` }, { status: 500 })
  }

  // Optional login for the new faculty (a brand-new email only).
  let login = false
  if (body.password) {
    const { data: au, error: authErr } = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true })
    if (authErr || !au?.user) return NextResponse.json({ error: `Faculty added, but the login could not be created: ${authErr?.message}. The Admin can set it from Credentials.` }, { status: 500 })
    await admin.from('app_users').update({ auth_id: au.user.id }).eq('id', created.id)
    await admin.from('user_credentials').upsert({ user_id: created.id, email, password_plain: body.password, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    login = true
  }

  await admin.from('audit_log').insert({ user_id: caller.id, action: `Faculty added — ${fullName}`, entity_type: 'app_user', entity_id: created.id, details: { centre_id: centreId, login } })
  return NextResponse.json({ ok: true, id: created.id, login })
}
