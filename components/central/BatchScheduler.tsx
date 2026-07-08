'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { checkWeeklyScheduleOverlap } from '@/lib/scheduling'
import { assignPlanner } from '@/lib/planners'
import { validateBatchDates, validateTimeRange } from '@/lib/validation'
import { DAYS, timesOverlap } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Program = { id: string; name: string }
type Centre = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string | null }
type Faculty = { id: string; full_name: string; email: string; centre_id: string | null }
type UserCentre = { user_id: string; centre_id: string }
type Manager = { id: string; full_name: string; role: string | null; roles?: string[]; centre_id: string | null }
type Planner = { id: string; name: string }
type Link = { id: string; batch_id: string; planner_id: string; faculty_id: string; stage: string; planners: { name: string } | { name: string }[] | null }

type Batch = {
  id: string
  name: string
  program_id: string
  centre_id: string
  start_date: string
  end_date: string
  batch_manager_id: string
  status: string
}

type ScheduleRow = {
  faculty_id: string
  subject_id: string
  start_time: string
  end_time: string
  days: boolean[]
}

type FlatSchedule = {
  day_of_week: number
  start_time: string
  end_time: string
  faculty_id: string
  subject_id: string | null
}

function flattenRows(rows: ScheduleRow[]): FlatSchedule[] {
  const result: FlatSchedule[] = []
  for (const row of rows) {
    if (!row.faculty_id) continue
    row.days.forEach((active, dayIndex) => {
      if (active) {
        result.push({
          day_of_week: dayIndex,
          start_time: row.start_time,
          end_time: row.end_time,
          faculty_id: row.faculty_id,
          subject_id: row.subject_id || null,
        })
      }
    })
  }
  return result
}

function plannerName(v: Link['planners']): string {
  if (!v) return 'Planner'
  if (Array.isArray(v)) return v[0]?.name ?? 'Planner'
  return v.name ?? 'Planner'
}

export default function BatchScheduler() {
  const supabase = createClient()
  const [batches, setBatches] = useState<Batch[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [managers, setManagers] = useState<Manager[]>([])
  const [planners, setPlanners] = useState<Planner[]>([])
  const [links, setLinks] = useState<Link[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [name, setName] = useState('')
  const [programId, setProgramId] = useState('')
  const [centreId, setCentreId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [managerId, setManagerId] = useState('')
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([])
  const [userCentres, setUserCentres] = useState<UserCentre[]>([])

  // Attach-planner modal
  const [attachBatch, setAttachBatch] = useState<Batch | null>(null)
  const [attachPlanner, setAttachPlanner] = useState('')
  const [attaching, setAttaching] = useState(false)

  const centreFaculty = useMemo(() => {
    if (!centreId) return []
    const ids = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))
    return faculty.filter((f) => ids.has(f.id) || f.centre_id === centreId)
  }, [faculty, centreId, userCentres])

  const centreManagers = useMemo(() => {
    if (!centreId) return []
    const ids = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))
    return managers.filter((m) => {
      const isBM = m.role === 'batch_manager' || (m.roles || []).includes('batch_manager')
      return isBM && (ids.has(m.id) || m.centre_id === centreId)
    })
  }, [managers, centreId, userCentres])

  const programSubjects = useMemo(
    () => subjects.filter((s) => s.program_id === programId),
    [subjects, programId]
  )

  const subjName = (id: string) => subjects.find((s) => s.id === id)?.name ?? 'Subject'

  // One row per subject of the program (subject fixed). Prefill from existing schedule on edit.
  const buildRows = (pid: string, flat: FlatSchedule[] = []): ScheduleRow[] =>
    subjects
      .filter((s) => s.program_id === pid)
      .map((s) => {
        const forSub = flat.filter((f) => f.subject_id === s.id)
        if (forSub.length) {
          const days = [false, false, false, false, false, false, false]
          forSub.forEach((f) => { days[f.day_of_week] = true })
          return { subject_id: s.id, faculty_id: forSub[0].faculty_id, start_time: forSub[0].start_time.slice(0, 5), end_time: forSub[0].end_time.slice(0, 5), days }
        }
        return { subject_id: s.id, faculty_id: '', start_time: '09:00', end_time: '10:00', days: [false, false, false, false, false, false, false] }
      })

  const handleProgramChange = (pid: string) => {
    setProgramId(pid)
    setScheduleRows(buildRows(pid))
  }

  const loadData = async () => {
    setLoading(true)
    setMessage(null)
    const [batchesRes, progRes, centRes, subjRes, facRes, manRes, ucRes, planRes, linkRes] = await Promise.all([
      supabase.from('batches').select('*').order('created_at', { ascending: false }),
      supabase.from('programs').select('*').order('name'),
      supabase.from('centres').select('id, name').order('name'),
      supabase.from('subjects').select('id, name, program_id').order('name'),
      supabase.rpc('list_active_faculty', { p_centre_id: null }),
      supabase.from('app_users').select('id, full_name, email, role, roles, centre_id').or('role.eq.batch_manager,roles.cs.{batch_manager}').eq('status', 'active').order('full_name'),
      supabase.from('user_centres').select('user_id, centre_id'),
      supabase.from('planners').select('id, name').order('created_at', { ascending: false }),
      supabase.from('batch_planner_links').select('id, batch_id, planner_id, faculty_id, stage, planners(name)'),
    ])

    if (batchesRes.error) setMessage({ type: 'error', text: batchesRes.error.message })
    if (batchesRes.data) setBatches(batchesRes.data)
    if (progRes.data) setPrograms(progRes.data)
    if (centRes.data) setCentres(centRes.data as Centre[])
    if (subjRes.data) setSubjects(subjRes.data as Subject[])

    if (facRes.error) {
      const fb = await supabase.from('app_users').select('id, full_name, email, centre_id').or('role.eq.faculty,roles.cs.{faculty}').eq('status', 'active').order('full_name')
      if (fb.data) setFaculty(Array.from(new Map(fb.data.map((f) => [f.id, f])).values()) as Faculty[])
    } else if (facRes.data) {
      setFaculty(Array.from(new Map((facRes.data as Faculty[]).map((f) => [f.id, f])).values()) as Faculty[])
    }

    if (manRes.data) setManagers(manRes.data as Manager[])
    if (ucRes.data) setUserCentres(ucRes.data as UserCentre[])
    if (planRes.data) setPlanners(planRes.data as Planner[])
    if (linkRes.data) setLinks(linkRes.data as unknown as Link[])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleCentreChange = (newCentreId: string) => {
    setCentreId(newCentreId)
    setManagerId((prev) => {
      const ids = new Set(userCentres.filter((uc) => uc.centre_id === newCentreId).map((uc) => uc.user_id))
      const valid = managers.some((m) => {
        const isBM = m.role === 'batch_manager' || (m.roles || []).includes('batch_manager')
        return m.id === prev && isBM && (ids.has(m.id) || m.centre_id === newCentreId)
      })
      return valid ? prev : ''
    })
    setScheduleRows((rows) =>
      rows.map((row) => {
        if (!row.faculty_id) return row
        const ids = new Set(userCentres.filter((uc) => uc.centre_id === newCentreId).map((uc) => uc.user_id))
        const fac = faculty.find((f) => f.id === row.faculty_id)
        if (!ids.has(row.faculty_id) && fac?.centre_id !== newCentreId) return { ...row, faculty_id: '' }
        return row
      })
    )
  }

  const handleEdit = async (b: Batch) => {
    setEditingBatch(b)
    setName(b.name)
    setProgramId(b.program_id)
    setCentreId(b.centre_id)
    setStartDate(b.start_date)
    setEndDate(b.end_date)
    setManagerId(b.batch_manager_id)
    const { data } = await supabase.from('batch_schedules').select('*').eq('batch_id', b.id)
    setScheduleRows(buildRows(b.program_id, (data || []) as FlatSchedule[]))
    setShowForm(true)
    setMessage(null)
  }

  const resetForm = () => {
    setEditingBatch(null)
    setName(''); setProgramId(''); setCentreId(''); setStartDate(''); setEndDate(''); setManagerId('')
    setScheduleRows([])
    setShowForm(false)
    setMessage(null)
  }

  const updateRow = (index: number, patch: Partial<ScheduleRow>) => {
    setScheduleRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const toggleDay = (rowIndex: number, dayIndex: number) => {
    if (!centreId) return
    setScheduleRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIndex) return r
        const days = [...r.days]
        days[dayIndex] = !days[dayIndex]
        return { ...r, days }
      })
    )
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)
    setSaving(true)

    const trimmedName = name.trim()
    if (!trimmedName) return fail('Batch name is required.')
    if (!programId) return fail('Select a program.')
    if (!centreId) return fail('Select a centre first.')
    const dateErr = validateBatchDates(startDate, endDate)
    if (dateErr) return fail(dateErr)

    if (programSubjects.length === 0) return fail('This program has no subjects. Add subjects in Admin → Programs first.')
    if (scheduleRows.length === 0) return fail('Select program & centre to load subjects.')

    const centreIds = new Set(userCentres.filter((uc) => uc.centre_id === centreId).map((uc) => uc.user_id))

    // Every subject MUST have a faculty + timing + at least one day.
    for (const row of scheduleRows) {
      const sName = subjName(row.subject_id)
      if (!row.faculty_id) return fail(`Assign a faculty for "${sName}". All subjects are mandatory.`)
      const timeErr = validateTimeRange(row.start_time, row.end_time)
      if (timeErr) return fail(`${sName}: ${timeErr}`)
      if (!row.days.some(Boolean)) return fail(`Pick at least one day for "${sName}".`)
      const fac = faculty.find((f) => f.id === row.faculty_id)
      if (!centreIds.has(row.faculty_id) && fac?.centre_id !== centreId) return fail(`${fac?.full_name ?? 'Faculty'} does not teach at this centre.`)
    }

    const flat = flattenRows(scheduleRows)

    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        if (flat[i].faculty_id === flat[j].faculty_id && flat[i].day_of_week === flat[j].day_of_week && timesOverlap(flat[i].start_time, flat[i].end_time, flat[j].start_time, flat[j].end_time)) {
          return fail(`Overlap in this batch on ${DAYS[flat[i].day_of_week]}.`)
        }
      }
    }

    for (const sch of flat) {
      const overlap = await checkWeeklyScheduleOverlap(supabase, sch.faculty_id, sch.day_of_week, sch.start_time, sch.end_time, editingBatch?.id)
      if (overlap) {
        const facName = faculty.find((f) => f.id === sch.faculty_id)?.full_name ?? 'Faculty'
        return fail(`${facName} — ${overlap} on ${DAYS[sch.day_of_week]}.`)
      }
    }

    let batchId = editingBatch?.id
    if (editingBatch) {
      const { error } = await supabase.from('batches').update({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).eq('id', editingBatch.id)
      if (error) return fail(error.message)
    } else {
      const { data, error } = await supabase.from('batches').insert({ name: trimmedName, program_id: programId, centre_id: centreId, start_date: startDate, end_date: endDate, batch_manager_id: managerId }).select().single()
      if (error) return fail(error.message)
      batchId = data.id
    }

    if (batchId) {
      await supabase.from('batch_schedules').delete().eq('batch_id', batchId)
      if (flat.length > 0) {
        const rows = flat.map((s) => ({ batch_id: batchId, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, faculty_id: s.faculty_id, subject_id: s.subject_id }))
        const { error } = await supabase.from('batch_schedules').insert(rows)
        if (error) return fail(error.message)
      }
    }

    setMessage({ type: 'success', text: editingBatch ? 'Batch updated.' : 'Batch created.' })
    resetForm()
    await loadData()
    setSaving(false)

    function fail(text: string) {
      setMessage({ type: 'error', text })
      setSaving(false)
    }
  }

  async function handleDelete(batch: Batch) {
    if (!confirm(`Delete batch "${batch.name}"? This also deletes its schedule and any planner links.`)) return
    setMessage(null)
    await supabase.from('batch_schedules').delete().eq('batch_id', batch.id)
    const { error } = await supabase.from('batches').delete().eq('id', batch.id)
    if (error) setMessage({ type: 'error', text: error.message })
    else { setMessage({ type: 'success', text: 'Batch deleted.' }); await loadData() }
  }

  function openAttach(batch: Batch) {
    setAttachBatch(batch)
    setAttachPlanner('')
    setMessage(null)
  }

  async function handleAttach() {
    if (!attachBatch || !attachPlanner) {
      setMessage({ type: 'error', text: 'Pick a planner.' })
      return
    }
    setAttaching(true)
    const res = await assignPlanner(supabase, {
      plannerId: attachPlanner,
      batch: { id: attachBatch.id, centre_id: attachBatch.centre_id, start_date: attachBatch.start_date, end_date: attachBatch.end_date },
    })
    setAttaching(false)
    if (!res.ok) {
      setMessage({ type: 'error', text: res.errors.join(' · ') })
      return
    }
    setMessage({ type: 'success', text: `Planner attached — ${res.imported} lecture(s) added${res.errors.length ? `, ${res.errors.length} skipped` : ''}. Manage stage in Batch Planner → Assign.` })
    setAttachBatch(null)
    await loadData()
  }

  const inputClass = 'w-full h-10 px-3 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent'

  return (
    <div>
      <PageHeader
        title="Batch Scheduler"
        description="Create batches and their week-wise recurring faculty schedule. Pick a subject per row. Overlapping timings are blocked. Optionally merge a batch with an existing planner."
        action={!showForm ? <BtnPrimary onClick={() => setShowForm(true)}>+ Create Batch</BtnPrimary> : undefined}
      />

      {message && <Alert type={message.type === 'info' ? 'info' : message.type}>{message.text}</Alert>}

      {showForm ? (
        <Card className="p-6 sm:p-8 mb-8">
          <form onSubmit={handleSave}>
            <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider mb-4">Batch Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Batch Name *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="CA Found-A" />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Program *</label>
                <select required value={programId} onChange={(e) => handleProgramChange(e.target.value)} className={inputClass}>
                  <option value="">Select program</option>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Centre *</label>
                <select required value={centreId} onChange={(e) => handleCentreChange(e.target.value)} className={inputClass}>
                  <option value="">Select centre</option>
                  {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Start Date *</label>
                <input required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">End Date *</label>
                <input required type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1">Batch Manager *</label>
                <select required value={managerId} onChange={(e) => setManagerId(e.target.value)} className={inputClass} disabled={!centreId}>
                  <option value="">{centreId ? 'Select manager' : 'Select centre first'}</option>
                  {centreManagers.map((m) => {
                    const role = m.role || m.roles?.[0] || 'staff'
                    return <option key={m.id} value={m.id}>{m.full_name} ({role.replace('_', ' ')})</option>
                  })}
                </select>
              </div>
            </div>

            {!programId ? (
              <Alert type="info">Select a program above — its subjects will load automatically, one row each.</Alert>
            ) : programSubjects.length === 0 ? (
              <Alert type="error">This program has no subjects yet. Add them in Admin → Programs first.</Alert>
            ) : !centreId ? (
              <Alert type="info">Select a centre to pick faculty for each subject.</Alert>
            ) : centreFaculty.length === 0 ? (
              <Alert type="error">No active faculty found for this centre. Add faculty in Admin first.</Alert>
            ) : (
              <>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold text-neutral-950 uppercase tracking-wider">Weekly Schedule</h3>
                </div>
                <p className="text-xs text-neutral-500 mb-4">
                  All <span className="font-semibold text-violet-600">{programSubjects.length} subjects</span> of this program must have a faculty &amp; timing — a batch can&apos;t run on one teacher. ({centreFaculty.length} faculty at {centres.find((c) => c.id === centreId)?.name})
                </p>

                <div className="overflow-x-auto border border-neutral-200 rounded-xl mb-8">
                  <table className="w-full text-sm min-w-[860px]">
                    <thead>
                      <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-3 font-semibold min-w-[150px]">Subject *</th>
                        <th className="text-left px-3 py-3 font-semibold min-w-[170px]">Faculty *</th>
                        <th className="text-left px-3 py-3 font-semibold">Start</th>
                        <th className="text-left px-3 py-3 font-semibold">End</th>
                        {DAYS.map((d) => <th key={d} className="px-2 py-3 font-semibold text-center w-10">{d}</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {scheduleRows.map((row, rowIndex) => {
                        const filled = row.faculty_id && row.days.some(Boolean)
                        return (
                        <tr key={row.subject_id} className={filled ? '' : 'bg-amber-50/40'}>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-2 font-semibold text-neutral-900">
                              <span className={`h-2 w-2 rounded-full ${filled ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                              {subjName(row.subject_id)}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <select value={row.faculty_id} onChange={(e) => updateRow(rowIndex, { faculty_id: e.target.value })} className={inputClass}>
                              <option value="">Select faculty</option>
                              {centreFaculty.map((f) => <option key={f.id} value={f.id}>{f.full_name}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-3"><input type="time" value={row.start_time} onChange={(e) => updateRow(rowIndex, { start_time: e.target.value })} className={inputClass} /></td>
                          <td className="px-3 py-3"><input type="time" value={row.end_time} onChange={(e) => updateRow(rowIndex, { end_time: e.target.value })} className={inputClass} /></td>
                          {DAYS.map((_, dayIndex) => (
                            <td key={dayIndex} className="px-2 py-3 text-center">
                              <button type="button" onClick={() => toggleDay(rowIndex, dayIndex)} className={`w-8 h-8 rounded-lg border text-xs font-bold transition-colors ${row.days[dayIndex] ? 'bg-violet-500 text-white border-violet-600' : 'bg-white text-neutral-300 border-neutral-200 hover:border-neutral-400'}`}>
                                {row.days[dayIndex] ? '✓' : '—'}
                              </button>
                            </td>
                          ))}
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex gap-3">
              <BtnPrimary type="submit" disabled={saving || !centreId}>{saving ? 'Saving…' : editingBatch ? 'Save Changes' : 'Create Batch'}</BtnPrimary>
              <BtnSecondary type="button" onClick={resetForm}>Cancel</BtnSecondary>
            </div>
          </form>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            <div className="col-span-full py-16 text-center text-neutral-400">Loading batches…</div>
          ) : batches.length === 0 ? (
            <div className="col-span-full py-16 text-center border border-dashed border-neutral-200 rounded-2xl text-neutral-500">No batches yet.</div>
          ) : (
            batches.map((b) => {
              const bl = links.filter((l) => l.batch_id === b.id)
              return (
                <Card key={b.id} className="p-6 hover:shadow-md transition-shadow flex flex-col">
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="font-bold text-neutral-950">{b.name}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{b.status}</span>
                  </div>
                  <div className="space-y-1.5 text-sm text-neutral-600 mb-4">
                    <p>{programs.find((p) => p.id === b.program_id)?.name}</p>
                    <p>{centres.find((c) => c.id === b.centre_id)?.name}</p>
                    <p className="text-xs text-neutral-400">{new Date(b.start_date).toLocaleDateString()} – {new Date(b.end_date).toLocaleDateString()}</p>
                  </div>
                  <div className="mb-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Linked Planners</p>
                    {bl.length === 0 ? (
                      <p className="text-xs text-neutral-400">None yet</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {bl.map((l) => (
                          <span key={l.id} className="text-[11px] bg-violet-50 text-violet-700 border border-violet-100 rounded px-2 py-0.5">{plannerName(l.planners)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-auto">
                    <BtnSecondary className="flex-1" onClick={() => handleEdit(b)}>Edit</BtnSecondary>
                    <button onClick={() => openAttach(b)} className="flex-1 px-3 py-2 bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 rounded-lg text-sm font-medium">Attach Planner</button>
                    <button onClick={() => handleDelete(b)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-sm font-medium">Delete</button>
                  </div>
                </Card>
              )
            })
          )}
        </div>
      )}

      {attachBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl border border-neutral-200">
            <h3 className="text-xl font-bold text-neutral-950 mb-1">Attach Planner</h3>
            <p className="text-sm text-neutral-500 mb-6">Merge <span className="font-semibold">{attachBatch.name}</span> with a planner. Each lecture is materialised onto this batch under the faculty set in the planner (overlaps blocked).</p>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Planner</label>
                <select value={attachPlanner} onChange={(e) => setAttachPlanner(e.target.value)} className={inputClass}>
                  <option value="">Select planner</option>
                  {planners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <BtnPrimary className="flex-1" onClick={handleAttach} disabled={attaching}>{attaching ? 'Attaching…' : 'Attach'}</BtnPrimary>
              <BtnSecondary className="flex-1" onClick={() => setAttachBatch(null)}>Cancel</BtnSecondary>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
