'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader, Card, Alert, BtnPrimary, BtnSecondary } from '@/components/PortalShell'

type Centre = { id: string; name: string }
type BatchManager = {
  id: string
  full_name: string
  email: string
  phone: string | null
  status: string
  centre_id: string | null
}

export default function ManageBatchManagersPage() {
  const supabase = createClient()
  const [managers, setManagers] = useState<BatchManager[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [centreId, setCentreId] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadData = async () => {
    setLoading(true)
    const [mgrRes, centresRes] = await Promise.all([
      supabase
        .from('app_users')
        .select('id, full_name, email, phone, status, centre_id')
        .or('role.eq.batch_manager,roles.cs.{batch_manager}')
        .order('full_name'),
      supabase.from('centres').select('id, name').order('name'),
    ])
    if (mgrRes.data) setManagers(mgrRes.data as unknown as BatchManager[])
    if (centresRes.data) setCentres(centresRes.data)
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const resetForm = () => {
    setFullName(''); setEmail(''); setPhone(''); setCentreId('')
    setEditingId(null); setShowForm(false)
  }

  const handleEdit = (m: BatchManager) => {
    setEditingId(m.id); setFullName(m.full_name); setEmail(m.email)
    setPhone(m.phone || ''); setCentreId(m.centre_id || ''); setShowForm(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim() || !email.trim() || !centreId) {
      setMessage({ type: 'error', text: 'Name, email, and centre are required.' })
      return
    }
    setSaving(true); setMessage(null)
    const cleanEmail = email.trim().toLowerCase()

    if (editingId) {
      const { error } = await supabase
        .from('app_users')
        .update({ full_name: fullName.trim(), email: cleanEmail, phone: phone.trim() || null, centre_id: centreId })
        .eq('id', editingId)
      if (error) { setMessage({ type: 'error', text: error.message }); setSaving(false); return }
    } else {
      const { data: existing } = await supabase
        .from('app_users').select('id, role, roles').eq('email', cleanEmail).maybeSingle()

      if (existing) {
        const existingRoles = Array.isArray(existing.roles) ? existing.roles.map(String) : existing.role ? [existing.role] : []
        const mergedRoles = Array.from(new Set([...existingRoles, 'batch_manager']))
        const { error } = await supabase
          .from('app_users')
          .update({ roles: mergedRoles, status: 'active', full_name: fullName.trim(), phone: phone.trim() || null, centre_id: centreId })
          .eq('id', existing.id)
        if (error) { setMessage({ type: 'error', text: error.message }); setSaving(false); return }
      } else {
        const { error } = await supabase.from('app_users').insert({
          full_name: fullName.trim(), email: cleanEmail, phone: phone.trim() || null,
          role: 'batch_manager', roles: ['batch_manager'], centre_id: centreId, status: 'active',
        })
        if (error) { setMessage({ type: 'error', text: error.message }); setSaving(false); return }
      }
    }

    // Also add to user_centres
    const { data: userId } = await supabase.from('app_users').select('id').eq('email', email.trim().toLowerCase()).single()
    if (userId && centreId) {
      await supabase.from('user_centres').upsert(
        { user_id: userId.id, centre_id: centreId, is_primary: true },
        { onConflict: 'user_id,centre_id' }
      )
    }

    setMessage({ type: 'success', text: editingId ? 'Updated.' : 'Added.' })
    resetForm(); loadData(); setSaving(false)
  }

  const handleToggleStatus = async (m: BatchManager) => {
    await supabase.from('app_users').update({ status: m.status === 'active' ? 'inactive' : 'active' }).eq('id', m.id)
    loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-neutral-950'

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        title="Batch Managers"
        description="Manage batch managers and assign them to centres."
        action={!showForm ? <BtnPrimary onClick={() => setShowForm(true)}>+ Add Manager</BtnPrimary> : undefined}
      />

      {message && <Alert type={message.type}>{message.text}</Alert>}

      {showForm && (
        <Card className="p-6 mb-6">
          <form onSubmit={handleSave}>
            <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider mb-4">
              {editingId ? 'Edit Batch Manager' : 'New Batch Manager'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Full name *</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Email *</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@pw.live" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Phone</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Centre *</label>
                <select value={centreId} onChange={(e) => setCentreId(e.target.value)} className={inputClass}>
                  <option value="">Select centre</option>
                  {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <BtnPrimary type="submit" disabled={saving}>{saving ? 'Saving...' : editingId ? 'Update' : 'Save'}</BtnPrimary>
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
          </form>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-neutral-400">Loading...</div>
        ) : managers.length === 0 ? (
          <div className="p-8 text-center text-neutral-400">No batch managers yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-semibold">Name</th>
                <th className="text-left px-4 py-3 font-semibold">Email</th>
                <th className="text-left px-4 py-3 font-semibold">Centre</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-right px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {managers.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3 font-medium text-neutral-950">{m.full_name}</td>
                  <td className="px-4 py-3 text-neutral-600">{m.email}</td>
                  <td className="px-4 py-3 text-neutral-600">{centres.find((c) => c.id === m.centre_id)?.name || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${m.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    <button onClick={() => handleEdit(m)} className="text-neutral-600 hover:text-neutral-950 text-xs font-medium">Edit</button>
                    <button onClick={() => handleToggleStatus(m)} className="text-neutral-400 hover:text-neutral-700 text-xs font-medium">
                      {m.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
