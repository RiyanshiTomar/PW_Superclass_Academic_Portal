import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // 1. Verify the caller is an admin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('app_users')
    .select('roles, role')
    .eq('email', user.email.toLowerCase())
    .maybeSingle()

  const callerRoles = Array.isArray(caller?.roles) && caller.roles.length > 0
    ? caller.roles
    : caller?.role ? [caller.role] : []

  if (!callerRoles.includes('admin')) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  // 2. Parse the body
  const body = await request.json()
  const { email, password, full_name, role, roles } = body as {
    email: string
    password: string
    full_name: string
    role?: string
    roles?: string[]
  }

  if (!email || !password || !full_name) {
    return NextResponse.json({ error: 'email, password, and full_name are required' }, { status: 400 })
  }

  const cleanEmail = email.trim().toLowerCase()

  // 3. Use service role client for admin operations
  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured on server' }, { status: 500 })
  }

  const adminSupabase = createAdminClient(serviceUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // 4. Ensure app_users row exists
    let { data: appUser } = await adminSupabase
      .from('app_users')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle()

    if (!appUser) {
      const userRoles = roles && roles.length > 0 ? roles : (role ? [role] : ['faculty'])
      const primaryRole = role || userRoles[0] || 'faculty'
      const { data: newUser, error: insertErr } = await adminSupabase
        .from('app_users')
        .insert({
          full_name: full_name.trim(),
          email: cleanEmail,
          role: primaryRole,
          roles: userRoles,
          status: 'active',
        })
        .select('id')
        .single()

      if (insertErr) throw new Error(`Failed to create app_user: ${insertErr.message}`)
      appUser = newUser
    }

    // 5. Create or update Supabase auth user
    // Find existing auth user by email
    let authId: string | null = null
    const { data: listData } = await adminSupabase.auth.admin.listUsers({ perPage: 1000 })
    if (listData?.users) {
      const existing = listData.users.find(
        (u) => (u.email || '').toLowerCase() === cleanEmail
      )
      if (existing) authId = existing.id
    }

    if (authId) {
      const { error } = await adminSupabase.auth.admin.updateUserById(authId, {
        password,
        email_confirm: true,
      })
      if (error) throw new Error(`Failed to update auth user: ${error.message}`)
    } else {
      const { data, error } = await adminSupabase.auth.admin.createUser({
        email: cleanEmail,
        password,
        email_confirm: true,
      })
      if (error) throw new Error(`Failed to create auth user: ${error.message}`)
      authId = data.user.id
    }

    // 6. Link auth_id to app_users
    await adminSupabase
      .from('app_users')
      .update({ auth_id: authId })
      .eq('id', appUser!.id)

    // 7. Upsert user_credentials
    const { error: credErr } = await adminSupabase
      .from('user_credentials')
      .upsert(
        {
          user_id: appUser!.id,
          email: cleanEmail,
          password_plain: password,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )

    if (credErr) throw new Error(`Failed to save credentials: ${credErr.message}`)

    return NextResponse.json({ ok: true, email: cleanEmail, user_id: appUser!.id })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.error('add-credentials error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
