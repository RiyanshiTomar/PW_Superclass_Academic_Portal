import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  const userEmail = data.user.email?.toLowerCase()
  if (!userEmail) {
    return NextResponse.redirect(`${origin}/login?error=no_email`)
  }

  const { data: linkResult, error: linkError } = await supabase.rpc('link_auth_and_get_role', {
    user_email: userEmail,
    user_auth_id: data.user.id,
  })

  const result = linkResult?.[0]

  if (linkError || !result) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=not_registered`)
  }

  if (result.user_status === 'inactive') {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=inactive`)
  }

  const activeRoles = Array.isArray(result.user_roles) && result.user_roles.length > 0
    ? result.user_roles
    : result.user_role
    ? [result.user_role]
    : []

  if (activeRoles.length === 0) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=no_access`)
  }

  if (activeRoles.length > 1) {
    return NextResponse.redirect(`${origin}/choose-role`)
  }

  const roleRedirects: Record<string, string> = {
    admin: '/admin',
    central_team: '/central',
    faculty: '/faculty',
    branch_head: '/branch',
    batch_manager: '/batch-manager',
  }

  const destination = roleRedirects[activeRoles[0]] || next
  return NextResponse.redirect(`${origin}${destination}`)
}
