'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch'
type Centre = { id: string; name: string; branch_head_id: string | null }
type Batch = { id: string; name: string; centre_id: string; start_date: string | null; end_date: string | null }
type Student = { id: string; regno: string; student_name: string; centre_id: string | null; batch_id: string | null; sheet_batch: string | null }

const todayISO = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }
const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)))

function batchStatus(b: Batch | undefined): { label: string; progress: number | null } {
  if (!b || !b.start_date || !b.end_date) return { label: '—', progress: null }
  const today = todayISO()
  if (today < b.start_date) return { label: 'Yet to start', progress: 0 }
  if (today > b.end_date) return { label: 'Completed', progress: 100 }
  const start = new Date(b.start_date + 'T12:00:00').getTime()
  const end = new Date(b.end_date + 'T12:00:00').getTime()
  const now = new Date(today + 'T12:00:00').getTime()
  const pct = end > start ? ((now - start) / (end - start)) * 100 : 0
  return { label: 'Ongoing', progress: clampPct(pct) }
}

function Spark({ pct, color }: { pct: number | null; color: string }) {
  if (pct == null) return <span className="text-neutral-300 text-xs">—</span>
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-2 bg-neutral-100 rounded-full overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${clampPct(pct)}%` }} /></div>
      <span className="text-[10px] font-semibold text-neutral-500 w-8">{clampPct(pct)}%</span>
    </div>
  )
}

export default function StudentsPanel({ scope = 'branch' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [centres, setCentres] = useState<Centre[]>([])
  const [centreId, setCentreId] = useState('')
  const [students, setStudents] = useState<Student[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [att, setAtt] = useState<Map<string, number | null>>(new Map())
  const [testPct, setTestPct] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadingCentre, setLoadingCentre] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const isPrivileged = scope === 'central' || scope === 'admin'

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const { data: c } = await supabase.from('centres').select('id, name, branch_head_id').order('name')
      setCentres((c ?? []) as Centre[])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const centresToShow = useMemo(() => {
    if (isPrivileged) return centres
    const ids = new Set(getUserCentreIds(appUser))
    if (appUser) centres.filter((c) => c.branch_head_id === appUser.id).forEach((c) => ids.add(c.id))
    return centres.filter((c) => ids.has(c.id))
  }, [centres, isPrivileged, appUser])

  useEffect(() => {
    if (!centreId && centresToShow.length === 1) setCentreId(centresToShow[0].id)
  }, [centresToShow, centreId])

  const loadCentre = async (cid: string) => {
    setLoadingCentre(true); setMsg(null)
    const [sRes, bRes] = await Promise.all([
      supabase.from('students').select('id, regno, student_name, centre_id, batch_id, sheet_batch').eq('centre_id', cid).order('student_name'),
      supabase.from('batches').select('id, name, centre_id, start_date, end_date').eq('centre_id', cid).order('name'),
    ])
    const studentsData = (sRes.data ?? []) as Student[]
    const batchesData = (bRes.data ?? []) as Batch[]
    setStudents(studentsData); setBatches(batchesData)

    // --- Attendance sparkline: present days / recorded days per regno ---
    const regnos = studentsData.map((s) => s.regno)
    const attMap = new Map<string, number | null>()
    if (regnos.length) {
      const { data: attRows } = await supabase.from('attendance').select('regno, attendance_date, first_punch_in').in('regno', regnos)
      const present = new Map<string, Set<string>>(), total = new Map<string, Set<string>>()
      for (const r of (attRows ?? []) as { regno: string; attendance_date: string; first_punch_in: string | null }[]) {
        if (!total.has(r.regno)) total.set(r.regno, new Set())
        total.get(r.regno)!.add(r.attendance_date)
        if (r.first_punch_in) { if (!present.has(r.regno)) present.set(r.regno, new Set()); present.get(r.regno)!.add(r.attendance_date) }
      }
      for (const reg of regnos) {
        const t = total.get(reg)?.size ?? 0
        attMap.set(reg, t ? ((present.get(reg)?.size ?? 0) / t) * 100 : null)
      }
    }
    setAtt(attMap)

    // --- Test completion sparkline: recorded results / batch's total tests ---
    const testMap = new Map<string, number | null>()
    const batchIds = batchesData.map((b) => b.id)
    if (batchIds.length) {
      const { data: tests } = await supabase.from('test_schedules').select('id, batch_id').in('batch_id', batchIds)
      const testsByBatch = new Map<string, Set<string>>()
      for (const t of (tests ?? []) as { id: string; batch_id: string }[]) {
        if (!testsByBatch.has(t.batch_id)) testsByBatch.set(t.batch_id, new Set())
        testsByBatch.get(t.batch_id)!.add(t.id)
      }
      const testIds = (tests ?? []).map((t) => t.id)
      const recordedByReg = new Map<string, Set<string>>()
      if (testIds.length) {
        const { data: results } = await supabase.from('test_results').select('test_id, regno, marks, absent').in('test_id', testIds)
        for (const r of (results ?? []) as { test_id: string; regno: string; marks: number | null; absent: boolean }[]) {
          if (r.marks == null && !r.absent) continue
          if (!recordedByReg.has(r.regno)) recordedByReg.set(r.regno, new Set())
          recordedByReg.get(r.regno)!.add(r.test_id)
        }
      }
      for (const s of studentsData) {
        if (!s.batch_id) { testMap.set(s.regno, null); continue }
        const totalT = testsByBatch.get(s.batch_id)?.size ?? 0
        if (!totalT) { testMap.set(s.regno, null); continue }
        const rec = recordedByReg.get(s.regno)
        const done = rec ? [...rec].filter((id) => testsByBatch.get(s.batch_id!)?.has(id)).length : 0
        testMap.set(s.regno, (done / totalT) * 100)
      }
    }
    setTestPct(testMap)
    setLoadingCentre(false)
  }

  useEffect(() => {
    if (centreId) loadCentre(centreId)
    else { setStudents([]); setBatches([]) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId])

  // Unassigned first, then by name.
  const ordered = useMemo(() => {
    return [...students].sort((a, b) => {
      const au = a.batch_id ? 1 : 0, bu = b.batch_id ? 1 : 0
      if (au !== bu) return au - bu
      return a.student_name.localeCompare(b.student_name)
    })
  }, [students])

  const assign = async (student: Student, batchId: string) => {
    setBusyId(student.id); setMsg(null)
    const { error } = await supabase.from('students').update({ batch_id: batchId || null, updated_at: new Date().toISOString() }).eq('id', student.id)
    setBusyId(null)
    if (error) { setMsg({ type: 'error', text: error.message }); return }
    setStudents((prev) => prev.map((s) => (s.id === student.id ? { ...s, batch_id: batchId || null } : s)))
    // Recompute the test sparkline for this student's new batch on next load; quick refresh:
    loadCentre(centreId)
  }

  const unassignedCount = students.filter((s) => !s.batch_id).length
  const centreName = centres.find((c) => c.id === centreId)?.name ?? ''

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Students" description={isPrivileged ? 'All students by centre. Assign each to a batch; unassigned float to the top.' : 'Your centre’s students. Assign each to a batch — unassigned are on top.'} />
      {msg && <Alert type={msg.type}>{msg.text}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-5">
        {(isPrivileged || centresToShow.length > 1) && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => setCentreId(e.target.value)} className="h-11 min-w-[220px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
              {centresToShow.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {centreId && !loadingCentre && (
          <div className="pb-2 text-sm text-neutral-500">
            {students.length} students · <span className="font-semibold text-amber-600">{unassignedCount} unassigned</span>
          </div>
        )}
      </div>

      {!centreId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a centre to see its students.</Card>
      ) : loadingCentre ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : students.length === 0 ? (
        <Alert type="info">No students at {centreName} yet. Run <code>npm run sync-students</code> to pull them from the sheet.</Alert>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[900px]">
              <thead>
                <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 font-semibold">SID</th>
                  <th className="px-3 py-3 font-semibold">Student</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 font-semibold min-w-[180px]">Batch</th>
                  <th className="px-3 py-3 font-semibold">Batch status</th>
                  <th className="px-3 py-3 font-semibold">Progress</th>
                  <th className="px-3 py-3 font-semibold">Attendance</th>
                  <th className="px-3 py-3 font-semibold">Tests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {ordered.map((s) => {
                  const b = batches.find((x) => x.id === s.batch_id)
                  const bs = batchStatus(b)
                  const assigned = !!s.batch_id
                  return (
                    <tr key={s.id} className={assigned ? 'hover:bg-neutral-50/60' : 'bg-amber-50/40'}>
                      <td className="px-4 py-2.5 font-mono text-xs text-neutral-500">{s.regno}</td>
                      <td className="px-3 py-2.5 font-medium text-neutral-900">{s.student_name || '—'}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${assigned ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{assigned ? 'Assigned' : 'Unassigned'}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <select value={s.batch_id ?? ''} disabled={busyId === s.id} onChange={(e) => assign(s, e.target.value)} className="h-9 w-full px-2 bg-white border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                          <option value="">— Unassigned —</option>
                          {batches.map((bt) => <option key={bt.id} value={bt.id}>{bt.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs font-medium ${bs.label === 'Ongoing' ? 'text-emerald-600' : bs.label === 'Completed' ? 'text-neutral-400' : bs.label === 'Yet to start' ? 'text-sky-600' : 'text-neutral-300'}`}>{bs.label}</span>
                      </td>
                      <td className="px-3 py-2.5"><Spark pct={bs.progress} color="bg-violet-500" /></td>
                      <td className="px-3 py-2.5"><Spark pct={att.get(s.regno) ?? null} color="bg-emerald-500" /></td>
                      <td className="px-3 py-2.5"><Spark pct={testPct.get(s.regno) ?? null} color="bg-sky-500" /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
