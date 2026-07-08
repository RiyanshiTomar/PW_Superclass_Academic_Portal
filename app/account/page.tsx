'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import Logo from '@/components/Logo'

export default function AccountPage() {
  const supabase = createClient()
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setEmail(user.email ?? '')
      const appUser = await getAppUser(supabase, user)
      if (appUser) setAppUserId(appUser.id)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (pw.length < 6) { setMsg({ type: 'err', text: 'Password must be at least 6 characters.' }); return }
    if (pw !== confirm) { setMsg({ type: 'err', text: 'Passwords do not match.' }); return }
    setBusy(true)

    // 1) Update the real auth password.
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) { setBusy(false); setMsg({ type: 'err', text: error.message }); return }

    // 2) Mirror it into the admin-visible credentials table (own row only).
    if (appUserId) {
      await supabase
        .from('user_credentials')
        .update({ password_plain: pw, updated_at: new Date().toISOString() })
        .eq('user_id', appUserId)
    }

    setBusy(false)
    setPw(''); setConfirm('')
    setMsg({ type: 'ok', text: 'Password updated. Use it next time you sign in.' })
  }

  const input = 'w-full h-11 px-4 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="min-h-screen bg-mesh flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <div className="flex justify-center mb-6"><Logo variant="full" size="lg" /></div>
        <div className="bg-white/90 border border-neutral-200/70 rounded-3xl shadow-xl p-8">
          <h1 className="text-xl font-extrabold text-neutral-950">Change password</h1>
          <p className="text-sm text-neutral-500 mt-1 mb-6">{email && <>Signed in as <span className="font-medium text-neutral-700">{email}</span></>}</p>

          <form onSubmit={save} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">New password</label>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 6 characters" className={input} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">Confirm new password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-type password" className={input} required />
            </div>
            <button type="submit" disabled={busy} className="w-full h-11 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:from-neutral-300 disabled:to-neutral-300 text-white rounded-xl text-sm font-semibold shadow-lg shadow-violet-500/30 transition-all">
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </form>

          {msg && (
            <div className={`mt-4 p-3 rounded-xl text-sm ${msg.type === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {msg.text}
            </div>
          )}

          <Link href="/" className="block text-center text-sm font-semibold text-violet-600 hover:text-violet-700 mt-6">← Back to my portal</Link>
        </div>
      </div>
    </div>
  )
}
