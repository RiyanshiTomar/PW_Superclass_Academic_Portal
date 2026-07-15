'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { parseCSVWithHeaders } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Scope = 'central' | 'admin' | 'branch'
type Centre = { id: string; name: string; branch_head_id: string | null }
type Batch = { id: string; name: string; centre_id: string; start_date: string | null; end_date: string | null }
type Student = { id: string; regno: string; student_name: string; centre_id: string | null; batch_id: string | null; sheet_batch: string | null }
type BatchFill = { assigned: number; capacity: number | null; allowed: number | null }
// One parsed CSV row, ready to preview before applying.
type UploadRow = { regno: string; name: string; studentId: string | null; currentBatchId: string | null; targetBatchId: string | null; skip: boolean; error: string; warning: string }

const todayISO = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }
const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)))
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()
const csvCell = (v: string) => (/[",\n]/.test(v ?? '') ? `"${(v ?? '').replace(/"/g, '""')}"` : (v ?? ''))

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
  const [schedules, setSchedules] = useState<{ batch_id: string; classroom_id: string | null }[]>([])
  const [rooms, setRooms] = useState<{ id: string; capacity: number | null }[]>([])
  const [att, setAtt] = useState<Map<string, number | null>>(new Map())
  const [testPct, setTestPct] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadingCentre, setLoadingCentre] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // CSV bulk-assign
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadRows, setUploadRows] = useState<UploadRow[] | null>(null)
  const [applying, setApplying] = useState(false)

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
      supabase.from('batches').select('id, name, centre_id, start_date, end_date').eq('centre_id', cid).neq('status', 'Merged').order('name'),
    ])
    const studentsData = (sRes.data ?? []) as Student[]
    const batchesData = (bRes.data ?? []) as Batch[]
    setStudents(studentsData); setBatches(batchesData)

    // Rooms each batch uses (for capacity) + the centre's room capacities.
    const [schedRes, roomRes] = await Promise.all([
      batchesData.length ? supabase.from('batch_schedules').select('batch_id, classroom_id').in('batch_id', batchesData.map((b) => b.id)) : Promise.resolve({ data: [] as { batch_id: string; classroom_id: string | null }[] }),
      supabase.from('classrooms').select('id, capacity').eq('centre_id', cid),
    ])
    setSchedules((schedRes.data ?? []) as { batch_id: string; classroom_id: string | null }[])
    setRooms((roomRes.data ?? []) as { id: string; capacity: number | null }[])

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
    else { setStudents([]); setBatches([]); setSchedules([]); setRooms([]) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId])

  // Per-batch fill: assigned students vs allowed = min room capacity × 1.25.
  const batchFill = useMemo(() => {
    const roomCap = new Map(rooms.map((r) => [r.id, r.capacity]))
    const capsByBatch = new Map<string, number[]>()
    for (const s of schedules) {
      if (!s.classroom_id) continue
      const cap = roomCap.get(s.classroom_id)
      if (cap == null) continue
      if (!capsByBatch.has(s.batch_id)) capsByBatch.set(s.batch_id, [])
      capsByBatch.get(s.batch_id)!.push(cap)
    }
    const assigned = new Map<string, number>()
    for (const st of students) if (st.batch_id) assigned.set(st.batch_id, (assigned.get(st.batch_id) ?? 0) + 1)
    const out = new Map<string, BatchFill>()
    for (const b of batches) {
      const caps = capsByBatch.get(b.id) ?? []
      const capacity = caps.length ? Math.min(...caps) : null
      out.set(b.id, { assigned: assigned.get(b.id) ?? 0, capacity, allowed: capacity != null ? Math.round(capacity * 1.25) : null })
    }
    return out
  }, [batches, students, schedules, rooms])

  const fillText = (bid: string | null | undefined) => {
    if (!bid) return ''
    const f = batchFill.get(bid)
    return f && f.allowed != null ? `${f.assigned}/${f.allowed}` : ''
  }
  const isOver = (bid: string | null | undefined) => {
    if (!bid) return false
    const f = batchFill.get(bid)
    return !!(f && f.allowed != null && f.assigned > f.allowed)
  }
  const batchLabel = (b: Batch) => { const ft = fillText(b.id); return ft ? `${b.name} (${ft})` : b.name }

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
    loadCentre(centreId)
  }

  // --- CSV bulk assign ---------------------------------------------------

  function downloadTemplate() {
    const header = ['Student ID', 'Student Name', 'Current Batch', 'Assign Batch']
    const lines = [header.join(',')]
    for (const s of ordered) lines.push([s.regno, s.student_name, batches.find((b) => b.id === s.batch_id)?.name ?? '', ''].map(csvCell).join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${centreName || 'centre'}-batch-assign.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleUploadCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMsg(null)
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      let iBatch = headers.findIndex((h) => h.includes('assign'))
      if (iBatch < 0) iBatch = headers.findIndex((h) => h.includes('batch') && !h.includes('current'))
      let iId = headers.findIndex((h) => ['student id', 'sid', 'regno', 'enrol', 'roll'].some((k) => h.includes(k)))
      if (iId < 0) iId = headers.findIndex((h) => h === 'id')
      if (iId < 0 || iBatch < 0) { setMsg({ type: 'error', text: 'CSV must have a Student ID column and an "Assign Batch" column.' }); if (fileRef.current) fileRef.current.value = ''; return }

      const studentByReg = new Map(students.map((s) => [norm(s.regno), s]))
      const batchByName = new Map(batches.map((b) => [norm(b.name), b.id]))

      // Parse rows (dedupe by regno — last wins).
      const byReg = new Map<string, UploadRow>()
      for (const row of rows) {
        const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
        const regno = get(iId)
        if (!regno) continue
        const assignRaw = get(iBatch)
        const student = studentByReg.get(norm(regno)) ?? null
        let error = '', warning = '', targetBatchId: string | null = null, skip = false
        if (!student) error = `Student ID "${regno}" is not at this centre`
        else if (!assignRaw) skip = true // blank = leave unchanged
        else {
          targetBatchId = batchByName.get(norm(assignRaw)) ?? null
          if (!targetBatchId) error = `Batch "${assignRaw}" not found at this centre`
        }
        byReg.set(norm(regno), { regno, name: student?.student_name ?? '', studentId: student?.id ?? null, currentBatchId: student?.batch_id ?? null, targetBatchId, skip, error, warning })
      }
      const parsed = Array.from(byReg.values())

      // Project post-upload counts to flag over-capacity.
      const projected = new Map<string, number>()
      for (const b of batches) projected.set(b.id, batchFill.get(b.id)?.assigned ?? 0)
      for (const r of parsed) {
        if (r.error || r.skip || !r.targetBatchId || r.targetBatchId === r.currentBatchId) continue
        if (r.currentBatchId) projected.set(r.currentBatchId, (projected.get(r.currentBatchId) ?? 0) - 1)
        projected.set(r.targetBatchId, (projected.get(r.targetBatchId) ?? 0) + 1)
      }
      for (const r of parsed) {
        if (r.error || r.skip || !r.targetBatchId) continue
        const allowed = batchFill.get(r.targetBatchId)?.allowed
        if (allowed != null && (projected.get(r.targetBatchId) ?? 0) > allowed) r.warning = `Over capacity (${projected.get(r.targetBatchId)}/${allowed})`
      }

      setUploadRows(parsed)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function applyUpload() {
    if (!uploadRows) return
    const changes = uploadRows.filter((r) => !r.error && !r.skip && r.studentId && r.targetBatchId !== r.currentBatchId)
    if (changes.length === 0) { setMsg({ type: 'info', text: 'No changes to apply.' }); setUploadRows(null); return }
    setApplying(true); setMsg(null)
    const byTarget = new Map<string, string[]>()
    for (const r of changes) { const key = r.targetBatchId ?? ''; if (!byTarget.has(key)) byTarget.set(key, []); byTarget.get(key)!.push(r.studentId!) }
    let failed = 0
    for (const [bid, ids] of byTarget) {
      const { error } = await supabase.from('students').update({ batch_id: bid || null, updated_at: new Date().toISOString() }).in('id', ids)
      if (error) failed += ids.length
    }
    setApplying(false)
    setUploadRows(null)
    setMsg(failed ? { type: 'error', text: `Applied ${changes.length - failed} assignment(s); ${failed} failed.` } : { type: 'success', text: `Applied ${changes.length} batch assignment(s).` })
    await loadCentre(centreId)
  }

  const unassignedCount = students.filter((s) => !s.batch_id).length
  const centreName = centres.find((c) => c.id === centreId)?.name ?? ''
  const uploadErrors = uploadRows?.filter((r) => r.error).length ?? 0
  const uploadWarnings = uploadRows?.filter((r) => !r.error && r.warning).length ?? 0
  const uploadChanges = uploadRows?.filter((r) => !r.error && !r.skip && r.targetBatchId !== r.currentBatchId).length ?? 0

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Students" description={isPrivileged ? 'All students by centre. Assign each to a batch; unassigned float to the top.' : 'Your centre’s students. Assign each to a batch — individually or via CSV. Unassigned are on top.'} />
      {msg && <Alert type={msg.type === 'info' ? 'info' : msg.type}>{msg.text}</Alert>}

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
          <>
            <div className="pb-2 text-sm text-neutral-500">
              {students.length} students · <span className="font-semibold text-amber-600">{unassignedCount} unassigned</span>
            </div>
            <div className="ml-auto flex gap-2 pb-1">
              <BtnSecondary onClick={downloadTemplate}>Download CSV</BtnSecondary>
              <label className="inline-flex items-center px-4 h-10 rounded-xl text-sm font-semibold cursor-pointer bg-neutral-100 hover:bg-neutral-200 text-neutral-700">
                Upload CSV
                <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleUploadCsv} />
              </label>
            </div>
          </>
        )}
      </div>

      {/* Batch capacity overview */}
      {centreId && !loadingCentre && batches.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {batches.map((b) => {
            const f = batchFill.get(b.id)
            const over = isOver(b.id)
            const pct = f && f.allowed ? clampPct((f.assigned / f.allowed) * 100) : 0
            return (
              <div key={b.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs ${over ? 'bg-red-50 border-red-200' : 'bg-white border-neutral-200'}`} title={f?.capacity != null ? `Room capacity ${f.capacity} × 1.25 = ${f.allowed}` : 'No room capacity set'}>
                <span className="font-semibold text-neutral-800">{b.name}</span>
                {f && f.allowed != null ? (
                  <>
                    <div className="w-14 h-1.5 bg-neutral-100 rounded-full overflow-hidden"><div className={`h-full ${over ? 'bg-red-500' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} /></div>
                    <span className={`font-bold ${over ? 'text-red-600' : 'text-neutral-500'}`}>{f.assigned}/{f.allowed}</span>
                  </>
                ) : (
                  <span className="text-neutral-400">{f?.assigned ?? 0} assigned · no capacity</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!centreId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a centre to see its students.</Card>
      ) : loadingCentre ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : students.length === 0 ? (
        <Alert type="info">No students at {centreName} yet. Run <code>npm run sync-students</code> to pull them from the enrollment sheet.</Alert>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[900px]">
              <thead>
                <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 font-semibold">SID</th>
                  <th className="px-3 py-3 font-semibold">Student</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 font-semibold min-w-[200px]">Batch</th>
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
                  const ft = fillText(s.batch_id)
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
                          {batches.map((bt) => <option key={bt.id} value={bt.id}>{batchLabel(bt)}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`text-xs font-medium ${bs.label === 'Ongoing' ? 'text-emerald-600' : bs.label === 'Completed' ? 'text-neutral-400' : bs.label === 'Yet to start' ? 'text-sky-600' : 'text-neutral-300'}`}>{bs.label}</span>
                        {ft && <span className={`ml-1.5 text-[11px] font-semibold ${isOver(s.batch_id) ? 'text-red-600' : 'text-neutral-400'}`}>· {ft}</span>}
                      </td>
                      <td className="px-3 py-2.5"><Spark pct={bs.progress} color="bg-violet-500" /></td>
                      {/* Attendance & tests are only meaningful once a batch is set
                          (measured against the batch's active class-days / tests). */}
                      <td className="px-3 py-2.5"><Spark pct={assigned ? (att.get(s.regno) ?? null) : null} color="bg-emerald-500" /></td>
                      <td className="px-3 py-2.5"><Spark pct={assigned ? (testPct.get(s.regno) ?? null) : null} color="bg-sky-500" /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* CSV upload preview */}
      {uploadRows && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl border border-neutral-200 flex flex-col max-h-[85vh]">
            <div className="p-6 border-b border-neutral-100">
              <h3 className="text-xl font-bold text-neutral-950 mb-1">Review batch assignments</h3>
              <p className="text-sm text-neutral-500">{uploadChanges} change(s) ready · <span className="text-red-600 font-medium">{uploadErrors} error(s)</span> · <span className="text-amber-600 font-medium">{uploadWarnings} over-capacity</span>. Errors are skipped; over-capacity rows still apply (your call).</p>
            </div>
            <div className="overflow-auto p-4">
              <table className="w-full text-left text-sm">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider"><th className="px-3 py-2">SID</th><th className="px-3 py-2">Student</th><th className="px-3 py-2">→ Batch</th><th className="px-3 py-2">Note</th></tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {uploadRows.map((r, i) => (
                    <tr key={i} className={r.error ? 'bg-rose-50/60' : r.warning ? 'bg-amber-50/50' : ''}>
                      <td className="px-3 py-2 font-mono text-xs text-neutral-500">{r.regno}</td>
                      <td className="px-3 py-2">{r.name || '—'}</td>
                      <td className="px-3 py-2">{r.error ? '—' : r.skip ? <span className="text-neutral-400">unchanged</span> : batches.find((b) => b.id === r.targetBatchId)?.name}</td>
                      <td className="px-3 py-2 text-xs">{r.error ? <span className="text-rose-600">{r.error}</span> : r.warning ? <span className="text-amber-600">{r.warning}</span> : r.skip ? '' : <span className="text-emerald-600">ok</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-6 border-t border-neutral-100 flex gap-3">
              <BtnPrimary onClick={applyUpload} disabled={applying || uploadChanges === 0}>{applying ? 'Applying…' : `Apply ${uploadChanges} assignment(s)`}</BtnPrimary>
              <BtnSecondary onClick={() => setUploadRows(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
