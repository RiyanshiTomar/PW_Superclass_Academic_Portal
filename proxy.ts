import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED_ROLE_PATHS: Record<string, string> = {
  '/admin': 'admin',
  '/central': 'central_team',
  '/faculty': 'faculty',
  '/branch': 'branch_head',
  '/batch-manager': 'batch_manager',
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request: { headers: request.headers } })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  // Allow public routes through
  const isPublicRoute =
    path === '/login' || path.startsWith('/auth/') || path === '/'

  if (isPublicRoute) {
    return response
  }

  // Not logged in -> send to login
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Check role match for protected sections
  const matchedPrefix = Object.keys(PROTECTED_ROLE_PATHS).find((prefix) =>
    path.startsWith(prefix)
  )

  if (matchedPrefix) {
    // Look up by email (since auth_id may not be set on app_users for manually inserted rows)
    const { data: appUser } = await supabase
      .from('app_users')
      .select('role, roles, status')
      .eq('email', user.email!.toLowerCase())
      .single()

    if (!appUser || appUser.status === 'inactive') {
      return NextResponse.redirect(new URL('/login?error=no_access', request.url))
    }

    const requiredRole = PROTECTED_ROLE_PATHS[matchedPrefix]
    const userRoles = Array.isArray(appUser.roles) && appUser.roles.length > 0
      ? appUser.roles
      : appUser.role
      ? [appUser.role]
      : []

    if (!userRoles.includes(requiredRole)) {
      // Logged in, but wrong portal -> bounce to their correct portal
      const roleRedirects: Record<string, string> = {
        admin: '/admin',
        central_team: '/central',
        faculty: '/faculty',
        branch_head: '/branch',
        batch_manager: '/batch-manager',
      }
      return NextResponse.redirect(
        new URL(roleRedirects[userRoles[0]] || '/login', request.url)
      )
    }
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}