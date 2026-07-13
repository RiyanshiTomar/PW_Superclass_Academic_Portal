'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { mergeProgram } from '@/lib/merge'

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
  const [mergeSrc, setMergeSrc] = useState<Program | null>(null)
  const [mergeTarget, setMergeTarget] = useState('')
  const [merging, setMerging] = useState(false)

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

  const handleMerge = async () => {
    if (!mergeSrc || !mergeTarget) return
    setMerging(true)
    setMessage(null)
    const res = await mergeProgram(supabase, mergeSrc.id, mergeTarget)
    setMerging(false)
    if (!res.ok) { setMessage({ type: 'error', text: 'Merge failed: ' + (res.error ?? '') }); return }
    const targetName = programs.find((p) => p.id === mergeTarget)?.name ?? 'target'
    setMessage({ type: 'success', text: `Merged "${mergeSrc.name}" into "${targetName}". All its batches & subjects moved over.` })
    setMergeSrc(null); setMergeTarget('')
    loadPrograms()
  }

  const handleDeleteProgram = async (id: string) => {
    const prog = programs.find((p) => p.id === id)
    const name = prog?.name ?? 'this program'

    // Guard: batches use ON DELETE RESTRICT, so a linked batch would block us.
    // Tell the user to reassign/remove those batches first (Batch Scheduler → Edit).
    const { count } = await supabase.from('batches').select('id', { count: 'exact', head: true }).eq('program_id', id)
    if (count && count > 0) {
      alert(`Can't delete "${name}" — ${count} batch(es) still use it.\n\nReassign them to the correct program (Central → Batch Scheduler → Edit) or delete those batches first, then try again.`)
      return
    }

    if (!confirm(`Delete program "${name}" and ALL its subjects, chapters & topics? This cannot be undone.`)) return

    // Subjects use ON DELETE SET NULL from programs, so delete them explicitly
    // (their chapters/topics cascade). Then remove the program.
    const subIds = (prog?.subjects ?? []).map((s) => s.id)
    if (subIds.length > 0) {
      const { error: sErr } = await supabase.from('subjects').delete().in('id', subIds)
      if (sErr) { alert('Failed to remove subjects: ' + sErr.message); return }
    }
    const { error } = await supabase.from('programs').delete().eq('id', id)
    if (error) { alert('Failed to delete program: ' + error.message); return }
    setMessage({ type: 'success', text: `Deleted "${name}" and its syllabus.` })
    loadPrograms()
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
                      setMergeSrc(p); setMergeTarget(''); setMessage(null)
                    }}
                    className="text-violet-600 hover:underline"
                  >
                    Merge
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

      {mergeSrc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setMergeSrc(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-gray-200 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-900 mb-1">Merge program</h3>
            <p className="text-sm text-gray-500 mb-4">Move everything from <span className="font-semibold">{mergeSrc.name}</span> into another program — its batches, subjects & chapters all get re-pointed, then <span className="font-semibold">{mergeSrc.name}</span> is deleted. Nothing else breaks.</p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Merge into</label>
            <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500">
              <option value="">Select the program to keep</option>
              {programs.filter((p) => p.id !== mergeSrc.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="flex gap-2">
              <button onClick={handleMerge} disabled={!mergeTarget || merging} className="h-10 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white rounded-lg text-sm font-medium">{merging ? 'Merging…' : 'Merge'}</button>
              <button onClick={() => setMergeSrc(null)} className="h-10 px-4 border border-gray-300 rounded-lg text-sm font-medium text-gray-700">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}