'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Centre = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string }
type Program = { id: string; name: string }

type Faculty = {
  id: string
  full_name: string
  email: string
  phone: string | null
  faculty_type: string | null
  status: string
  centre_id: string | null
}

export default function ManageFacultyPage() {
  const supabase = createClient()
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('')

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [facultyType, setFacultyType] = useState('Permanent')
  const [centreId, setCentreId] = useState('')
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([])

  const loadAll = async () => {
    setLoading(true)
    const [facultyRes, centresRes, programsRes, subjectsRes] = await Promise.all([
      supabase
        .from('app_users')
        .select('id, full_name, email, phone, faculty_type, status, centre_id')
        .or('role.eq.faculty,roles.cs.{faculty}')
        .order('full_name'),
      supabase.from('centres').select('id, name').order('name'),
      supabase.from('programs').select('id, name').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
    ])

    if (facultyRes.error) {
      setMessage({ type: 'error', text: `Failed to load faculty: ${facultyRes.error.message}. Run fix_combined.sql in Supabase.` })
    }
    if (facultyRes.data) setFaculty(facultyRes.data as unknown as Faculty[])
    if (centresRes.data) setCentres(centresRes.data)
    if (programsRes.data) setPrograms(programsRes.data)
    if (subjectsRes.data) setSubjects(subjectsRes.data)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  const resetForm = () => {
    setFullName('')
    setEmail('')
    setPhone('')
    setFacultyType('Permanent')
    setCentreId('')
    setSelectedSubjectIds([])
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = async (f: Faculty) => {
    setEditingId(f.id)
    setFullName(f.full_name)
    setEmail(f.email)
    setPhone(f.phone || '')
    setFacultyType(f.faculty_type || 'Permanent')
    setCentreId(f.centre_id || '')

    const { data } = await supabase
      .from('faculty_subjects')
      .select('subject_id')
      .eq('faculty_id', f.id)
    setSelectedSubjectIds(data?.map((d) => d.subject_id) || [])

    setShowForm(true)
  }

  const toggleSubject = (id: string) => {
    setSelectedSubjectIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim() || !email.trim()) {
      setMessage({ type: 'error', text: 'Name and email are required.' })
      return
    }
    setSaving(true)
    setMessage(null)

    const cleanEmail = email.trim().toLowerCase()
    let facultyId = editingId

    if (editingId) {
      const { error } = await supabase
        .from('app_users')
        .update({
          full_name: fullName.trim(),
          email: cleanEmail,
          phone: phone.trim() || null,
          faculty_type: facultyType,
          centre_id: centreId || null,
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
        const mergedRoles = Array.from(new Set([...existingRoles, 'faculty']))

        const { error } = await supabase
          .from('app_users')
          .update({
            roles: mergedRoles,
            status: 'active',
            full_name: fullName.trim(),
            email: cleanEmail,
            phone: phone.trim() || null,
            faculty_type: facultyType,
            centre_id: centreId || null,
          })
          .eq('id', existing.id)

        if (error) {
          setMessage({ type: 'error', text: 'Failed to update existing user. ' + error.message })
          setSaving(false)
          return
        }

        facultyId = existing.id
      } else {
        const { data: newFaculty, error: insertError } = await supabase
          .from('app_users')
          .insert({
            full_name: fullName.trim(),
            email: cleanEmail,
            phone: phone.trim() || null,
            role: 'faculty',
            roles: ['faculty'],
            faculty_type: facultyType,
            centre_id: centreId || null,
            status: 'active',
          })
          .select()
          .single()

        if (insertError || !newFaculty) {
          setMessage({ type: 'error', text: 'Failed to add faculty. ' + insertError?.message })
          setSaving(false)
          return
        }
        facultyId = newFaculty.id
      }
    }

    // Sync subjects
    if (facultyId) {
      await supabase.from('faculty_subjects').delete().eq('faculty_id', facultyId)
      if (selectedSubjectIds.length > 0) {
        const rows = selectedSubjectIds.map((subject_id) => ({
          faculty_id: facultyId,
          subject_id,
        }))
        await supabase.from('faculty_subjects').insert(rows)
      }
    }

    // Sync user_centres junction (required for batch scheduler dropdown)
    if (facultyId && centreId) {
      // Remove old centre assignments
      await supabase.from('user_centres').delete().eq('user_id', facultyId)
      // Add new centre assignment (primary)
      await supabase.from('user_centres').insert({
        user_id: facultyId,
        centre_id: centreId,
        is_primary: true,
      })
    }

    setMessage({ type: 'success', text: editingId ? 'Faculty updated.' : 'Faculty added.' })
    resetForm()
    loadAll()
    setSaving(false)
  }

  const handleToggleStatus = async (f: Faculty) => {
    const newStatus = f.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase
      .from('app_users')
      .update({ status: newStatus })
      .eq('id', f.id)
    if (!error) loadAll()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this faculty? This cannot be undone.')) return
    const { error } = await supabase.from('app_users').delete().eq('id', id)
    if (error) {
      alert('Cannot delete — this faculty may be linked to batches or planners. Consider deactivating instead.')
    } else {
      loadAll()
    }
  }

  const filteredFaculty = faculty.filter((f) => {
    const matchesSearch =
      f.full_name.toLowerCase().includes(search.toLowerCase()) ||
      f.email.toLowerCase().includes(search.toLowerCase())
    const matchesCentre = !filterCentre || f.centre_id === filterCentre
    return matchesSearch && matchesCentre
  })

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Manage Faculty</h1>
          <p className="text-sm text-gray-500">{faculty.length} faculty registered.</p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            + Add Faculty
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">
            {editingId ? 'Edit Faculty' : 'New Faculty'}
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
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={facultyType}
                onChange={(e) => setFacultyType(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="Permanent">Permanent</option>
                <option value="Hourly/Contract">Hourly/Contract</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Centre</label>
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

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-2">Subjects taught</label>
            <div className="space-y-3 max-h-56 overflow-y-auto border border-gray-200 rounded-lg p-3">
              {programs.map((p) => {
                const progSubjects = subjects.filter((s) => s.program_id === p.id)
                if (progSubjects.length === 0) return null
                return (
                  <div key={p.id}>
                    <div className="text-xs font-medium text-gray-500 mb-1">{p.name}</div>
                    <div className="flex flex-wrap gap-2">
                      {progSubjects.map((s) => (
                        <label
                          key={s.id}
                          className={`text-xs px-2.5 py-1 rounded-full border cursor-pointer ${
                            selectedSubjectIds.includes(s.id)
                              ? 'bg-blue-50 border-blue-400 text-blue-700'
                              : 'bg-white border-gray-300 text-gray-600'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="hidden"
                            checked={selectedSubjectIds.includes(s.id)}
                            onChange={() => toggleSubject(s.id)}
                          />
                          {s.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
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

      <div className="flex gap-3 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="h-9 px-3 border border-gray-300 rounded-lg text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={filterCentre}
          onChange={(e) => setFilterCentre(e.target.value)}
          className="h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All centres</option>
          {centres.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : filteredFaculty.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No faculty found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium">Email</th>
                <th className="text-left px-4 py-2.5 font-medium">Centre</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredFaculty.map((f) => (
                <tr key={f.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-medium text-gray-900">{f.full_name}</td>
                  <td className="px-4 py-3 text-gray-600">{f.email}</td>
                  <td className="px-4 py-3 text-gray-600">{centres.find((c) => c.id === f.centre_id)?.name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{f.faculty_type || '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        f.status === 'active'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {f.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => handleEdit(f)}
                      className="text-blue-600 hover:underline text-xs"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggleStatus(f)}
                      className="text-gray-500 hover:underline text-xs"
                    >
                      {f.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDelete(f.id)}
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