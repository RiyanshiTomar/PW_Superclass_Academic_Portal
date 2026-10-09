'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds } from '@/lib/auth'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

// ============================================================
// Branch head with the 'centre_admin' permission: see the centre's faculty
// and add NEW faculty (subjects + optional login) — own centre(s) only.
// ============================================================

type Centre = { id: string; name: string }
type Fac = { id: string; full_name: string; email: string | null; faculty_type: string | null }
type Subject = { id: string; name: string; program_id: string | null }
type Program = { id: string; name: string }

export default function CentreFaculty() {
  const supabase = createClient()
  const [centres, setCentres] = useState<Centre[]>([])
  const [centreId, setCentreId] = useState('')
  const [faculty, setFaculty] = useState<Fac[]>([])
  const [subjectsByFac, setSubjectsByFac] = useState<Record<string, string[]>>({})
  const [programs, setPrograms] = useState<Program[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', faculty_type: 'Permanent', password: '' })
  const [programId, setProgramId] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      const ids = new Set(getUserCentreIds(au))
      const [cRes, pRes, sRes] = await Promise.all([
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('programs').select('id, name').order('name'),
        supabase.from('subjects').select('id, name, program_id').order('name'),
      ])
      const mine = ((cRes.data ?? []) as (Centre & { branch_head_id: string | null })[]).filter((c) => ids.has(c.id) || c.branch_head_id === au?.id)
      setCentres(mine)
      setCentreId((cur) => cur || mine[0]?.id || '')
      setPrograms((pRes.data ?? []) as Program[])
      setSubjects((sRes.data ?? []) as Subject[])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadFaculty = async (cid: string) => {
    const { data } = await supabase.rpc('list_active_faculty', { p_centre_id: cid })
    const list = Array.from(new Map(((data ?? []) as Fac[]).map((f) => [f.id, f])).values()).sort((a, b) => a.full_name.localeCompare(b.full_name))
    setFaculty(list)
    if (list.length) {
      const { data: fs } = await supabase.from('faculty_subjects').select('faculty_id, subjects(name)').in('faculty_id', list.map((f) => f.id))
      const m: Record<string, string[]> = {}
      for (const r of (fs ?? []) as { faculty_id: string; subjects: { name: string } | { name: string }[] | null }[]) {
        const n = Array.isArray(r.subjects) ? r.subjects[0]?.name : r.subjects?.name
        if (n) (m[r.faculty_id] ??= []).push(n)
      }
      setSubjectsByFac(m)
    }
  }
  useEffect(() => { if (centreId) void loadFaculty(centreId) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [centreId])

  const programSubjects = useMemo(() => subjects.filter((s) => s.program_id === programId), [subjects, programId])

  const save = async () => {
    setSaving(true); setMsg(null)
    const res = await fetch('/api/centre/faculty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, centre_id: centreId, subject_ids: Array.from(picked) }),
    })
    const j = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setMsg({ type: 'error', text: j.error || 'Could not add faculty.' }); return }
    setMsg({ type: 'success', text: `${form.full_name} added${j.login ? ' — they can log in with this email and password' : ''}.` })
    setOpen(false); setForm({ full_name: '', email: '', phone: '', faculty_type: 'Permanent', password: '' }); setPicked(new Set()); setProgramId('')
    void loadFaculty(centreId)
  }

  const input = 'w-full h-10 px-3 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'
  const centreName = centres.find((c) => c.id === centreId)?.name ?? ''

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Faculty" description="Your centre's faculty. Add new faculty here — they appear in the Batch Scheduler and planner for your centre straight away." />
      {msg && <Alert type={msg.type}>{msg.text}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-5">
        {centres.length > 1 && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => setCentreId(e.target.value)} className={`${input} min-w-[220px]`}>
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div className="ml-auto"><BtnPrimary onClick={() => { setOpen(true); setMsg(null) }} disabled={!centreId}>+ Add faculty</BtnPrimary></div>
      </div>

      {loading ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : !centreId ? (
        <Alert type="info">No centre is linked to your account.</Alert>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-left text-sm">
            <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
              <th className="px-4 py-3">Name</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Subjects</th>
            </tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {faculty.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-neutral-400">No faculty at {centreName} yet.</td></tr>}
              {faculty.map((f) => (
                <tr key={f.id}>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{f.full_name}</td>
                  <td className="px-3 py-2.5 text-neutral-500">{f.email || '—'}</td>
                  <td className="px-3 py-2.5 text-neutral-500">{f.faculty_type || '—'}</td>
                  <td className="px-3 py-2.5 text-neutral-600">{(subjectsByFac[f.id] ?? []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm" onClick={() => !saving && setOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-neutral-200 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 space-y-3">
              <h3 className="text-xl font-bold text-neutral-950">Add faculty · {centreName}</h3>
              <div><label className="block text-xs font-medium text-neutral-500 mb-1">Full name *</label><input className={input} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
              <div><label className="block text-xs font-medium text-neutral-500 mb-1">Email *</label><input className={input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@pw.live" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-neutral-500 mb-1">Phone</label><input className={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div><label className="block text-xs font-medium text-neutral-500 mb-1">Type</label>
                  <select className={input} value={form.faculty_type} onChange={(e) => setForm({ ...form, faculty_type: e.target.value })}>
                    <option value="Permanent">Permanent</option><option value="Hourly/Contract">Hourly/Contract</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Subjects they teach</label>
                <select className={input} value={programId} onChange={(e) => setProgramId(e.target.value)}>
                  <option value="">Pick a program…</option>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {programId && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {programSubjects.map((s) => (
                      <label key={s.id} className={`px-2.5 py-1 rounded-lg border text-xs cursor-pointer ${picked.has(s.id) ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-neutral-700 border-neutral-200'}`}>
                        <input type="checkbox" className="sr-only" checked={picked.has(s.id)} onChange={() => setPicked((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })} />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
                {picked.size > 0 && <p className="text-xs text-neutral-500 mt-1">{picked.size} subject(s) selected</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Login password (optional, min 8 characters)</label>
                <input className={input} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Leave empty — Admin can set it later" />
              </div>
              <div className="flex gap-2 pt-2">
                <BtnPrimary className="flex-1" onClick={save} disabled={saving || !form.full_name.trim() || !form.email.trim()}>{saving ? 'Adding…' : 'Add faculty'}</BtnPrimary>
                <BtnSecondary onClick={() => setOpen(false)} disabled={saving}>Cancel</BtnSecondary>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
