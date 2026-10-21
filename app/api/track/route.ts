import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { istDay, portalOf, sectionOf } from '@/lib/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Records one page view (or a sign-in) for the signed-in user. Called by the
// UsageTracker in the root layout and by the login form. Never blocks or
// breaks the page: any failure just returns 204.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) return new NextResponse(null, { status: 204 })

    let body: { path?: unknown; event?: unknown } = {}
    try { body = JSON.parse(await request.text()) } catch { /* empty body */ }

    const { data: me } = await supabase.from('app_users').select('id').eq('email', user.email.toLowerCase()).maybeSingle()
    if (!me) return new NextResponse(null, { status: 204 })

    if (body.event === 'login') {
      await supabase.from('login_events').insert({ user_id: me.id, user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null })
    } else if (typeof body.path === 'string' && body.path.startsWith('/')) {
      const section = sectionOf(body.path)
      if (section !== '/login') await supabase.rpc('track_usage', { p_user: me.id, p_day: istDay(), p_section: section, p_portal: portalOf(section) })
    }
  } catch (e) {
    console.error('usage track failed', e)
  }
  return new NextResponse(null, { status: 204 })
}
