'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Centre = { id: string; name: string }
type BranchHead = {
  id: string
  full_name: string
  email: string
  phone: string | null
  status: string
  centre_id: string | null
}

export default function ManageBranchHeadsPage() {
  const supabase = createClient()
  const [heads, setHeads] = useState<BranchHead[]>([])
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
    const [headsRes, centresRes] = await Promise.all([
      supabase
        .from('app_users')
        .select('id, full_name, email, phone, status, centre_id')
        .or('role.eq.branch_head,roles.cs.{branch_head}')
        .order('full_name'),
      supabase.from('centres').select('id, name').order('name'),
    ])

    if (headsRes.data) setHeads(headsRes.data as unknown as BranchHead[])
    if (centresRes.data) setCentres(centresRes.data)
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const resetForm = () => {
    setFullName('')
    setEmail('')
    setPhone('')
    setCentreId('')
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = (h: BranchHead) => {
    setEditingId(h.id)
    setFullName(h.full_name)
    setEmail(h.email)
    setPhone(h.phone || '')
    setCentreId(h.centre_id || '')
    setShowForm(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim() || !email.trim() || !centreId) {
      setMessage({ type: 'error', text: 'Name, email, and centre are required.' })
      return
    }
    setSaving(true)
    setMessage(null)
    const cleanEmail = email.trim().toLowerCase()

    if (editingId) {
      const { error } = await supabase
        .from('app_users')
        .update({
          full_name: fullName.trim(),
          email: cleanEmail,
          phone: phone.trim() || null,
          centre_id: centreId,
        })
        .eq('id', editingId)

      if (error) {
        setMessage({ type: 'error', text: 'Failed to update. ' + error.message })
        setSaving(false)
        return
      }
    } else {
      const { data: existing, error: existingError } = await supabase
        .from('app_users')
        .select('id, role, roles')
        .eq('email', cleanEmail)
        .maybeSingle()

      if (existingError) {
        setMessage({ type: 'error', text: 'Failed to lookup user. ' + existingError.message })
        setSaving(false)
        return
      }

      if (existing) {
        const existingRoles = Array.isArray(existing.roles)
          ? existing.roles.map((role) => String(role))
          : existing.role
          ? [existing.role]
          : []
        const mergedRoles = Array.from(new Set([...existingRoles, 'branch_head']))

        const { error } = await supabase
          .from('app_users')
          .update({ roles: mergedRoles, status: 'active', full_name: fullName.trim(), phone: phone.trim() || null, centre_id: centreId })
          .eq('id', existing.id)

        if (error) {
          setMessage({ type: 'error', text: 'Failed to update existing user. ' + error.message })
          setSaving(false)
          return
        }
      } else {
        const { error } = await supabase.from('app_users').insert({
          full_name: fullName.trim(),
          email: cleanEmail,
          phone: phone.trim() || null,
          role: 'branch_head',
          roles: ['branch_head'],
          centre_id: centreId,
        })

        if (error) {
          setMessage({ type: 'error', text: 'Failed to add branch head. ' + error.message })
          setSaving(false)
          return
        }
      }
    }

    // Also update centres.branch_head_id for convenience
    const userIdRes = editingId
      ? { id: editingId }
      : await supabase
          .from('app_users')
          .select('id')
          .eq('email', cleanEmail)
          .single()
          .then((r) => r.data)

    if (userIdRes?.id) {
      await supabase.from('centres').update({ branch_head_id: userIdRes.id }).eq('id', centreId)
    }

    setMessage({ type: 'success', text: editingId ? 'Branch head updated.' : 'Branch head added.' })
    resetForm()
    loadData()
    setSaving(false)
  }

  const handleToggleStatus = async (h: BranchHead) => {
    const newStatus = h.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.from('app_users').update({ status: newStatus }).eq('id', h.id)
    if (!error) loadData()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this branch head?')) return
    const { error } = await supabase.from('app_users').delete().eq('id', id)
    if (error) {
      alert('Cannot delete — try deactivating instead.')
    } else {
      loadData()
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Manage Branch Heads</h1>
          <p className="text-sm text-gray-500">Assign branch heads to centres.</p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            + Add Branch Head
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">
            {editingId ? 'Edit Branch Head' : 'New Branch Head'}
          </h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Full name *</label>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@pw.live"
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Centre *</label>
              <select
                value={centreId}
                onChange={(e) => setCentreId(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select centre</option>
                {centres.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="h-10 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg text-sm font-medium"
            >
              {saving ? 'Saving...' : editingId ? 'Update' : 'Save'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="h-10 px-4 border border-gray-300 rounded-lg text-sm font-medium text-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : heads.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No branch heads yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium">Email</th>
                <th className="text-left px-4 py-2.5 font-medium">Centre</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {heads.map((h) => (
                <tr key={h.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-medium text-gray-900">{h.full_name}</td>
                  <td className="px-4 py-3 text-gray-600">{h.email}</td>
                  <td className="px-4 py-3 text-gray-600">{centres.find((c) => c.id === h.centre_id)?.name || '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        h.status === 'active'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {h.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => handleEdit(h)}
                      className="text-blue-600 hover:underline text-xs"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggleStatus(h)}
                      className="text-gray-500 hover:underline text-xs"
                    >
                      {h.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDelete(h.id)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}