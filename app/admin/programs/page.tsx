'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Subject = { id: string; name: string }
type Program = { id: string; name: string; subjects: Subject[] }

export default function ManageProgramsPage() {
  const supabase = createClient()
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [programName, setProgramName] = useState('')
  const [subjectsText, setSubjectsText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newSubjectName, setNewSubjectName] = useState('')

  const loadPrograms = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('programs')
      .select('id, name, subjects(id, name)')
      .order('name')

    if (error) {
      setMessage({ type: 'error', text: 'Failed to load programs: ' + error.message })
    } else if (data) {
      setPrograms(data as unknown as Program[])
      if (data.length === 0) {
        setMessage({ type: 'success', text: 'No programs yet. Add one above or run the import script.' })
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    loadPrograms()
  }, [])

  const resetForm = () => {
    setProgramName('')
    setSubjectsText('')
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = (p: Program) => {
    setEditingId(p.id)
    setProgramName(p.name)
    setSubjectsText(p.subjects.map((s) => s.name).join(', '))
    setShowForm(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!programName.trim()) {
      setMessage({ type: 'error', text: 'Please enter a program name.' })
      return
    }
    setSaving(true)
    setMessage(null)

    if (editingId) {
      const { error } = await supabase
        .from('programs')
        .update({ name: programName.trim() })
        .eq('id', editingId)

      if (error) {
        setMessage({ type: 'error', text: 'Failed to update. ' + error.message })
        setSaving(false)
        return
      }
    } else {
      // Check if program already exists
      const { data: existing } = await supabase
        .from('programs')
        .select('id')
        .eq('name', programName.trim())
        .maybeSingle()

      let newProgramId: string

      if (existing) {
        // Program exists, use it
        newProgramId = existing.id
        setMessage({ type: 'success', text: `Program "${programName.trim()}" already exists. Adding subjects to it.` })
      } else {
        // Create new program
        const { data: newProgram, error } = await supabase
          .from('programs')
          .insert({ name: programName.trim() })
          .select()
          .single()

        if (error || !newProgram) {
          setMessage({ type: 'error', text: 'Failed to add program. ' + error?.message })
          setSaving(false)
          return
        }
        newProgramId = newProgram.id
      }

      // Add subjects if provided (comma separated)
      const subjectNames = subjectsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      if (subjectNames.length > 0) {
        const rows = subjectNames.map((name) => ({ program_id: newProgramId, name }))
        await supabase.from('subjects').insert(rows)
      }
    }

    setMessage({ type: 'success', text: editingId ? 'Program updated.' : 'Program added.' })
    resetForm()
    loadPrograms()
    setSaving(false)
  }

  const handleAddSubject = async (programId: string) => {
    if (!newSubjectName.trim()) return
    const { error } = await supabase
      .from('subjects')
      .insert({ program_id: programId, name: newSubjectName.trim() })

    if (!error) {
      setNewSubjectName('')
      loadPrograms()
    }
  }

  const handleDeleteSubject = async (subjectId: string) => {
    if (!confirm('Delete this subject?')) return
    const { error } = await supabase.from('subjects').delete().eq('id', subjectId)
    if (!error) loadPrograms()
  }

  const handleDeleteProgram = async (id: string) => {
    if (!confirm('Delete this program and all its subjects? This cannot be undone.')) return
    const { error } = await supabase.from('programs').delete().eq('id', id)
    if (error) {
      alert('Cannot delete — this program may have batches linked to it.')
    } else {
      loadPrograms()
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Manage Programs</h1>
          <p className="text-sm text-gray-500">Add programs and their subjects.</p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            + Add Program
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">
            {editingId ? 'Edit Program' : 'New Program'}
          </h3>
          <div className="space-y-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Program name</label>
              <input
                value={programName}
                onChange={(e) => setProgramName(e.target.value)}
                placeholder="e.g. CA Foundation"
                className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {!editingId && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Subjects (comma separated)
                </label>
                <input
                  value={subjectsText}
                  onChange={(e) => setSubjectsText(e.target.value)}
                  placeholder="e.g. Accounts, Business Law, Quantitative Aptitude"
                  className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400 mt-1">You can add more subjects later too.</p>
              </div>
            )}
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

      <div className="space-y-3">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm bg-white border border-gray-200 rounded-xl">
            Loading...
          </div>
        ) : programs.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm bg-white border border-gray-200 rounded-xl">
            No programs yet. Add one above.
          </div>
        ) : (
          programs.map((p) => (
            <div key={p.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
              >
                <div>
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-xs text-gray-400 ml-2">{p.subjects.length} subjects</span>
                </div>
                <div className="space-x-3 text-xs">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleEdit(p)
                    }}
                    className="text-blue-600 hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteProgram(p.id)
                    }}
                    className="text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === p.id && (
                <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                  <div className="flex flex-wrap gap-2 mb-3">
                    {p.subjects.map((s) => (
                      <span
                        key={s.id}
                        className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 rounded-full px-3 py-1"
                      >
                        {s.name}
                        <button
                          onClick={() => handleDeleteSubject(s.id)}
                          className="text-gray-400 hover:text-red-600 ml-1"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={newSubjectName}
                      onChange={(e) => setNewSubjectName(e.target.value)}
                      placeholder="New subject name"
                      className="h-8 px-3 border border-gray-300 rounded-lg text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => handleAddSubject(p.id)}
                      className="h-8 px-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium"
                    >
                      Add subject
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}