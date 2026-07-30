This Next.js App Router project has no centralized error-handling system. Errors are handled locally and informally in two places:

1. **Auth callback (`app/auth/callback/route.ts`)** — Supabase `exchangeCodeForSession` and the `link_auth_and_get_role` RPC return `{ data, error }`. Each failure path immediately redirects to `/login?error=<code>` (e.g. `auth_failed`, `no_email`, `not_registered`, `inactive`, `no_access`). There is no shared error type or logging; each branch hard-codes its own query-string token.

2. **Proxy middleware (`proxy.ts`)** — Role checks on protected routes also redirect to `/login?error=no_access` when a user is inactive or lacks the required role. Again, this is an ad-hoc string appended to the URL.

3. **Server-side Supabase client (`lib/supabase/server.ts`)** — The only `try/catch` in the codebase wraps `cookieStore.setAll`; it silently ignores failures when called from Server Components (a known Supabase SSR caveat). No custom error wrapping occurs.

4. **Admin pages** — Client-side mutations call Supabase directly and check the returned `error` object, setting a local `message` state of `{ type: 'error', text: error.message }`. There is no global toast, no retry logic, and no structured error propagation.

There is no `errors/` directory, no custom `Error` subclasses, no sentinel values, no `panic`/`recover` equivalent, and no middleware-level error interceptor. Validation helpers in `lib/validation.ts` and `lib/utils.ts` do not throw or return typed errors. The scripts under `scripts/` use bare Node `console.error` / process exit codes rather than structured error objects.