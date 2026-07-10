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

type Classroom = {
  id: string
  centre_id: string
  room_no: string | null
  name: string
  capacity: number | null
  is_active: boolean
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

  // Classrooms (halls) per centre
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [roomsCentre, setRoomsCentre] = useState<Centre | null>(null)
  const [roomNo, setRoomNo] = useState('')
  const [roomName, setRoomName] = useState('')
  const [roomCapacity, setRoomCapacity] = useState('')
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null)
  const [roomSaving, setRoomSaving] = useState(false)

  const loadCentres = async () => {
    setLoading(true)
    const [cenRes, roomRes] = await Promise.all([
      supabase.from('centres').select('id, name, city, is_active, branch_head_id').order('name'),
      supabase.from('classrooms').select('id, centre_id, room_no, name, capacity, is_active').order('room_no'),
    ])
    if (!cenRes.error && cenRes.data) setCentres(cenRes.data)
    if (!roomRes.error && roomRes.data) setClassrooms(roomRes.data as Classroom[])
    setLoading(false)
  }

  useEffect(() => {
    loadCentres()
  }, [])

  const centreRooms = (centreId: string) => classrooms.filter((r) => r.centre_id === centreId)

  const resetRoomForm = () => {
    setRoomNo('')
    setRoomName('')
    setRoomCapacity('')
    setEditingRoomId(null)
  }

  const handleSaveRoom = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!roomsCentre) return
    if (!roomName.trim()) {
      setMessage({ type: 'error', text: 'Room name is required.' })
      return
    }
    const capacity = roomCapacity.trim() ? parseInt(roomCapacity, 10) : null
    if (capacity !== null && (Number.isNaN(capacity) || capacity <= 0)) {
      setMessage({ type: 'error', text: 'Capacity must be a positive number.' })
      return
    }
    setRoomSaving(true)
    setMessage(null)
    if (editingRoomId) {
      const { error } = await supabase.from('classrooms').update({ room_no: roomNo.trim() || null, name: roomName.trim(), capacity }).eq('id', editingRoomId)
      if (error) setMessage({ type: 'error', text: 'Failed to update room. ' + error.message })
      else { setMessage({ type: 'success', text: 'Room updated.' }); resetRoomForm(); await loadCentres() }
    } else {
      const { error } = await supabase.from('classrooms').insert({ centre_id: roomsCentre.id, room_no: roomNo.trim() || null, name: roomName.trim(), capacity })
      if (error) setMessage({ type: 'error', text: error.message.includes('duplicate') ? 'A room with that name already exists at this centre.' : 'Failed to add room. ' + error.message })
      else { setMessage({ type: 'success', text: 'Room added.' }); resetRoomForm(); await loadCentres() }
    }
    setRoomSaving(false)
  }

  const handleEditRoom = (room: Classroom) => {
    setEditingRoomId(room.id)
    setRoomNo(room.room_no ?? '')
    setRoomName(room.name)
    setRoomCapacity(room.capacity != null ? String(room.capacity) : '')
  }

  const handleToggleRoom = async (room: Classroom) => {
    const { error } = await supabase.from('classrooms').update({ is_active: !room.is_active }).eq('id', room.id)
    if (!error) await loadCentres()
  }

  const handleDeleteRoom = async (room: Classroom) => {
    if (!confirm(`Delete room "${room.name}"? If any batch schedule uses it, deactivate instead.`)) return
    const { error } = await supabase.from('classrooms').delete().eq('id', room.id)
    if (error) alert('Cannot delete — this room may be used by a batch schedule. Deactivate it instead.')
    else await loadCentres()
  }

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
                      onClick={() => { setRoomsCentre(c); resetRoomForm(); setMessage(null) }}
                      className="text-violet-600 hover:underline text-xs font-medium"
                    >
                      Rooms ({centreRooms(c.id).length})
                    </button>
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

      {roomsCentre && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => { setRoomsCentre(null); resetRoomForm() }}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-gray-200 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <h3 className="font-semibold text-gray-900">Rooms — {roomsCentre.name}</h3>
                <p className="text-xs text-gray-500">Physical halls at this centre. A class can only run in one of these, and no two classes can share a room at the same time.</p>
              </div>
              <button onClick={() => { setRoomsCentre(null); resetRoomForm() }} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>

            <form onSubmit={handleSaveRoom} className="p-5 border-b border-gray-100 flex items-end gap-2">
              <div className="w-24">
                <label className="block text-xs font-medium text-gray-600 mb-1">Room no.</label>
                <input value={roomNo} onChange={(e) => setRoomNo(e.target.value)} placeholder="CR1 / 101" className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">Room name</label>
                <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Study Space" className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
              </div>
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
                <input type="number" min={1} value={roomCapacity} onChange={(e) => setRoomCapacity(e.target.value)} placeholder="Opt." className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
              </div>
              <button type="submit" disabled={roomSaving} className="h-10 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white rounded-lg text-sm font-medium whitespace-nowrap">
                {roomSaving ? 'Saving…' : editingRoomId ? 'Update' : '+ Add'}
              </button>
              {editingRoomId && (
                <button type="button" onClick={resetRoomForm} className="h-10 px-3 border border-gray-300 rounded-lg text-sm text-gray-700">Cancel</button>
              )}
            </form>

            <div className="p-4 overflow-y-auto">
              {centreRooms(roomsCentre.id).length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No rooms yet. Add the first one above.</p>
              ) : (
                <ul className="space-y-2">
                  {centreRooms(roomsCentre.id).map((room) => (
                    <li key={room.id} className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-xl">
                      <div>
                        {room.room_no && <span className="text-xs font-mono text-gray-400 mr-2">{room.room_no}</span>}
                        <span className="font-medium text-gray-900 text-sm">{room.name}</span>
                        {room.capacity != null && <span className="text-xs text-gray-500 ml-2">· seats {room.capacity}</span>}
                        {!room.is_active && <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 text-gray-500 px-2 py-0.5 rounded-full ml-2">Inactive</span>}
                      </div>
                      <div className="space-x-2 text-xs">
                        <button onClick={() => handleEditRoom(room)} className="text-blue-600 hover:underline">Edit</button>
                        <button onClick={() => handleToggleRoom(room)} className="text-gray-500 hover:underline">{room.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button onClick={() => handleDeleteRoom(room)} className="text-red-600 hover:underline">Delete</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}