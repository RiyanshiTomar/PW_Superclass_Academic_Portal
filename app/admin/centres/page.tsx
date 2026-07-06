'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Centre = {
  id: string
  name: string
  city: string
  is_active: boolean
  branch_head_id: string | null
}

export default function ManageCentresPage() {
  const supabase = createClient()
  const [centres, setCentres] = useState<Centre[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadCentres = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('centres')
      .select('id, name, city, is_active, branch_head_id')
      .order('name')

    if (!error && data) setCentres(data)
    setLoading(false)
  }

  useEffect(() => {
    loadCentres()
  }, [])

  const resetForm = () => {
    setName('')
    setCity('')
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = (centre: Centre) => {
    setEditingId(centre.id)
    setName(centre.name)
    setCity(centre.city)
    setShowForm(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !city.trim()) {
      setMessage({ type: 'error', text: 'Please fill in both fields.' })
      return
    }
    setSaving(true)
    setMessage(null)

    if (editingId) {
      const { error } = await supabase
        .from('centres')
        .update({ name: name.trim(), city: city.trim() })
        .eq('id', editingId)

      if (error) {
        setMessage({ type: 'error', text: 'Failed to update centre. ' + error.message })
      } else {
        setMessage({ type: 'success', text: 'Centre updated.' })
        resetForm()
        loadCentres()
      }
    } else {
      const { error } = await supabase
        .from('centres')
        .insert({ name: name.trim(), city: city.trim() })

      if (error) {
        setMessage({ type: 'error', text: 'Failed to add centre. ' + error.message })
      } else {
        setMessage({ type: 'success', text: 'Centre added.' })
        resetForm()
        loadCentres()
      }
    }
    setSaving(false)
  }

  const handleToggleActive = async (centre: Centre) => {
    const { error } = await supabase
      .from('centres')
      .update({ is_active: !centre.is_active })
      .eq('id', centre.id)

    if (!error) loadCentres()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this centre? This cannot be undone.')) return
    const { error } = await supabase.from('centres').delete().eq('id', id)
    if (error) {
      alert('Cannot delete — this centre may have batches or faculty linked to it. Consider deactivating instead.')
    } else {
      loadCentres()
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Manage Centres</h1>
          <p className="text-sm text-gray-500">Add, edit, or deactivate centres.</p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            + Add Centre
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">
            {editingId ? 'Edit Centre' : 'New Centre'}
          </h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Centre name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Laxmi Nagar Superclass"
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. New Delhi"
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
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
        ) : centres.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No centres yet. Add one above.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium">City</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {centres.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600">{c.city}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        c.is_active ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {c.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => handleEdit(c)}
                      className="text-blue-600 hover:underline text-xs"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggleActive(c)}
                      className="text-gray-500 hover:underline text-xs"
                    >
                      {c.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
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