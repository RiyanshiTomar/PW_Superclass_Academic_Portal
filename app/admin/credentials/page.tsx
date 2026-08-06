'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

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

const ROLE_OPTIONS = [
  { value: 'faculty', label: 'Faculty' },
  { value: 'central_team', label: 'Central Team' },
  { value: 'admin', label: 'Admin' },
  { value: 'branch_head', label: 'Branch Head' },
  { value: 'batch_manager', label: 'Batch Manager' },
  { value: 'syllabus_editor', label: 'Syllabus Editor' },
]

function genPassword() {
  return `Superclass@${Math.floor(1000 + Math.random() * 9000)}`
}

export default function CredentialsPage() {
  const supabase = createClient()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Add-user modal state
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addPassword, setAddPassword] = useState(genPassword())
  const [addRole, setAddRole] = useState('faculty')
  const [addSaving, setAddSaving] = useState(false)
  const [addMsg, setAddMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const loadCredentials = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('user_credentials')
      .select('email, password_plain, updated_at, app_users(full_name, role, roles)')
    if (error) setError(error.message)
    else setRows((data ?? []) as unknown as Row[])
    setLoading(false)
  }

  useEffect(() => {
    loadCredentials()
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

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddMsg(null)

    const cleanEmail = addEmail.trim().toLowerCase()
    if (!cleanEmail.endsWith('@pw.live')) {
      setAddMsg({ type: 'err', text: 'Email must end in @pw.live' })
      return
    }
    if (!addName.trim()) {
      setAddMsg({ type: 'err', text: 'Name is required' })
      return
    }
    if (addPassword.length < 6) {
      setAddMsg({ type: 'err', text: 'Password must be at least 6 characters' })
      return
    }

    setAddSaving(true)
    try {
      const res = await fetch('/api/internal/add-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          password: addPassword,
          full_name: addName.trim(),
          role: addRole,
          roles: [addRole],
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAddMsg({ type: 'err', text: data.error || 'Failed to add credentials' })
      } else {
        setAddMsg({ type: 'ok', text: `✓ Credentials created for ${cleanEmail}` })
        // Reset form
        setAddName('')
        setAddEmail('')
        setAddPassword(genPassword())
        setAddRole('faculty')
        // Refresh the table
        await loadCredentials()
      }
    } catch (err) {
      setAddMsg({ type: 'err', text: 'Network error. Try again.' })
    } finally {
      setAddSaving(false)
    }
  }

  const input = 'h-10 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Credentials"
        description="Every staff member's login email and password. Admin-only — locked from all other users. Passwords a user changes themselves update here automatically."
        action={
          <BtnPrimary onClick={() => { setShowAdd(true); setAddMsg(null) }}>
            + Add Credentials
          </BtnPrimary>
        }
      />

      {error && <Alert type="error">Could not load credentials: {error}. (Only admins can view this.)</Alert>}

      {/* ====== Add Credentials Modal ====== */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={() => setShowAdd(false)}>
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl animate-fade-up"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-neutral-950 mb-1">Add User + Credentials</h3>
            <p className="text-sm text-neutral-500 mb-5">
              Creates a portal user, Supabase auth account, and saves credentials — all in one step.
            </p>

            <form onSubmit={handleAddSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Full Name *</label>
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="e.g. Raman Kumar"
                  className={`${input} w-full`}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Email *</label>
                <input
                  type="email"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  placeholder="e.g. raman.kumar@pw.live"
                  className={`${input} w-full`}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Password *</label>
                <div className="flex gap-2">
                  <input
                    value={addPassword}
                    onChange={(e) => setAddPassword(e.target.value)}
                    className={`${input} flex-1 font-mono`}
                    required
                  />
                  <BtnSecondary
                    type="button"
                    onClick={() => setAddPassword(genPassword())}
                    className="!h-10 !px-3 text-xs"
                  >
                    Regenerate
                  </BtnSecondary>
                </div>
                <p className="text-xs text-neutral-400 mt-1">Auto-generated. Change it if you want a custom one.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Role</label>
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value)}
                  className={`${input} w-full`}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <BtnSecondary type="button" onClick={() => setShowAdd(false)} className="flex-1">
                  Cancel
                </BtnSecondary>
                <BtnPrimary type="submit" disabled={addSaving} className="flex-1">
                  {addSaving ? 'Creating…' : 'Create User + Credentials'}
                </BtnPrimary>
              </div>
            </form>

            {addMsg && (
              <div className={`mt-4 p-3 rounded-xl text-sm ${addMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
                {addMsg.text}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====== Search + Toggle ====== */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" className={`${input} flex-1 min-w-[220px]`} />
        <button onClick={() => setReveal((r) => !r)} className="h-10 px-4 rounded-xl text-sm font-semibold bg-white border border-neutral-200 hover:border-violet-400 text-neutral-700">
          {reveal ? 'Hide passwords' : 'Show passwords'}
        </button>
      </div>

      {/* ====== Table ====== */}
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
                <tr><td colSpan={4} className="px-4 py-10 text-center text-neutral-400">{rows.length === 0 ? 'No credentials yet. Use the + Add Credentials button above.' : 'No matches.'}</td></tr>
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
