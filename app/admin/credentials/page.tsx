'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Row = {
  email: string
  password_plain: string
  updated_at: string
  app_users: { full_name: string; role: string; roles: string[] } | { full_name: string; role: string; roles: string[] }[] | null
}

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

export default function CredentialsPage() {
  const supabase = createClient()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data, error } = await supabase
        .from('user_credentials')
        .select('email, password_plain, updated_at, app_users(full_name, role, roles)')
      if (error) setError(error.message)
      else setRows((data ?? []) as unknown as Row[])
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = rows
      .map((r) => ({ ...r, u: one(r.app_users) }))
      .sort((a, b) => (a.u?.full_name ?? '').localeCompare(b.u?.full_name ?? ''))
    if (!term) return list
    return list.filter((r) => (r.u?.full_name ?? '').toLowerCase().includes(term) || r.email.toLowerCase().includes(term))
  }, [rows, q])

  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1200) } catch { /* ignore */ }
  }

  const input = 'h-10 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Credentials"
        description="Every staff member's login email and password. Admin-only — locked from all other users. Passwords a user changes themselves update here automatically."
      />

      {error && <Alert type="error">Could not load credentials: {error}. (Only admins can view this.)</Alert>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" className={`${input} flex-1 min-w-[220px]`} />
        <button onClick={() => setReveal((r) => !r)} className="h-10 px-4 rounded-xl text-sm font-semibold bg-white border border-neutral-200 hover:border-violet-400 text-neutral-700">
          {reveal ? 'Hide passwords' : 'Show passwords'}
        </button>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Email</th>
                <th className="px-4 py-3 font-semibold">Password</th>
                <th className="px-4 py-3 font-semibold">Roles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-neutral-400">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-neutral-400">{rows.length === 0 ? 'No credentials yet. Run the seed script.' : 'No matches.'}</td></tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.email} className="hover:bg-violet-50/50">
                    <td className="px-4 py-3 font-medium text-neutral-900">{r.u?.full_name ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-700">
                      <button onClick={() => copy(r.email, 'e' + r.email)} className="hover:text-violet-700" title="Copy email">
                        {r.email} {copied === 'e' + r.email && <span className="text-emerald-600 text-xs">✓</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono">
                      <button onClick={() => copy(r.password_plain, 'p' + r.email)} className="hover:text-violet-700" title="Copy password">
                        {reveal ? (r.password_plain || '—') : '••••••••'} {copied === 'p' + r.email && <span className="text-emerald-600 text-xs font-sans">copied</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(r.u?.roles ?? []).map((role) => (
                          <span key={role} className="text-[10px] font-semibold uppercase tracking-wider bg-violet-50 text-violet-700 ring-1 ring-violet-200 px-2 py-0.5 rounded-full">{role.replace('_', ' ')}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-neutral-400 mt-4">{filtered.length} of {rows.length} staff · Click an email or password to copy.</p>
    </div>
  )
}
