'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Logo from '@/components/Logo'

const ERROR_MESSAGES: Record<string, string> = {
  no_access: 'Your account is inactive or not registered. Contact admin.',
  inactive: 'Your account has been deactivated. Contact admin.',
  not_registered: 'This email is not registered on the portal.',
  auth_failed: 'Login link expired or invalid. Request a new magic link.',
  no_email: 'No email found on your account. Contact admin.',
}

export default function LoginForm() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const searchParams = useSearchParams()
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const error = searchParams.get('error')
    if (error && ERROR_MESSAGES[error]) {
      setMessage({ type: 'error', text: ERROR_MESSAGES[error] })
    }
  }, [searchParams])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        router.replace('/')
      } else {
        setCheckingSession(false)
      }
    })
  }, [router, supabase])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const cleanEmail = email.trim().toLowerCase()

    if (!cleanEmail.endsWith('@pw.live')) {
      setMessage({ type: 'error', text: 'Use your PW email address (must end in @pw.live).' })
      setLoading(false)
      return
    }

    const { data, error: lookupError } = await supabase.rpc('check_email_registered', {
      check_email: cleanEmail,
    })

    if (lookupError) {
      setMessage({ type: 'error', text: 'Could not verify email. Try again in a moment.' })
      setLoading(false)
      return
    }

    const result = data?.[0]

    if (!result?.is_registered) {
      setMessage({ type: 'error', text: 'This email is not registered. Contact your admin.' })
      setLoading(false)
      return
    }

    if (!result.is_active) {
      setMessage({ type: 'error', text: 'Your account is deactivated. Contact your admin.' })
      setLoading(false)
      return
    }

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: cleanEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: true, // Auto-create auth user on first login
      },
    })

    if (otpError) {
      setMessage({ type: 'error', text: otpError.message.includes('rate') ? 'Too many attempts. Wait a minute and retry.' : 'Could not send magic link. Try again.' })
      setLoading(false)
      return
    }

    setMessage({ type: 'success', text: `Magic link sent to ${cleanEmail}. Open it on this device to sign in.` })
    setLoading(false)
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="flex items-center gap-3 text-violet-200 text-sm">
          <span className="h-4 w-4 rounded-full border-2 border-violet-300/40 border-t-violet-400 animate-spin" />
          Checking session…
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-mesh-dark relative overflow-hidden">
      <div className="absolute -top-32 -left-32 h-80 w-80 rounded-full bg-violet-500/30 blur-3xl animate-floaty" />
      <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-violet-600/20 blur-3xl animate-floaty" style={{ animationDelay: '2s' }} />
      <div className="absolute top-1/3 right-1/4 h-40 w-40 rounded-full bg-amber-400/10 blur-3xl animate-floaty" style={{ animationDelay: '4s' }} />

      <div className="w-full max-w-md relative animate-fade-up">
        <div className="flex flex-col items-center mb-8">
          <Logo variant="full" onDark size="xl" className="mb-4 animate-pop" />
          <p className="text-sm text-neutral-400 mt-2">Sign in with your PW email</p>
        </div>

        <div className="glass rounded-3xl p-8 shadow-2xl border border-white/30 ring-1 ring-white/10">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700 mb-1.5">Email address</label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="yourname@pw.live"
                className="w-full h-11 px-4 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:from-neutral-300 disabled:to-neutral-300 text-white rounded-xl text-sm font-semibold shadow-lg shadow-violet-500/30 disabled:shadow-none transition-all"
            >
              {loading ? 'Sending…' : 'Send magic link'}
            </button>
          </form>

          {message && (
            <div className={`mt-4 p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {message.text}
            </div>
          )}

          <p className="text-xs text-neutral-400 text-center mt-6">Only registered PW Superclass staff can access this portal.</p>
        </div>
      </div>
    </div>
  )
}
