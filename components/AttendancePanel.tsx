'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser, getUserCentreIds, type AppUser } from '@/lib/auth'
import { DAYS_FULL } from '@/lib/utils'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Batch = { id: string; name: string; centre_id: string; batch_manager_id: string | null }
type Centre = { id: string; name: string; branch_head_id: string | null }
type MapRow = { portal_batch_id: string; sheet_batch_id: string | null; batch_name: string }
type Sched = { day_of_week: number; start_time: string; end_time: string }
type PlanRow = { planned_date: string; start_time: string | null; duration_minutes: number }
type AttRow = {
  regno: string
  student_name: string
  attendance_date: string
  first_punch_in: string | null
  last_punch_out: string | null
  admission_status: string | null
  batch_name: string | null
}
type Instance = { regno: string; name: string; date: string; at?: string }

const WINDOWS = [7, 15, 30, 60, 90]

function parseTimeToMin(raw: string | null): number | null {
  if (!raw) return null
  const m = String(raw).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const ap = m[3]?.toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return h * 60 + min
}
const todayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d }
const iso = (d: Date) => d.toISOString().split('T')[0]
const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })

// One card per issue category — explicit Tailwind classes (no dynamic class names).
const CAT_STYLES: Record<string, { tile: string; num: string; label: string; pill: string }> = {
  absent:    { tile: 'border-rose-100 bg-gradient-to-br from-rose-50 to-white',       num: 'text-rose-600',   label: 'text-rose-900/60',   pill: 'bg-rose-600' },
  late:      { tile: 'border-amber-100 bg-gradient-to-br from-amber-50 to-white',      num: 'text-amber-600',  label: 'text-amber-900/60',  pill: 'bg-amber-500' },
  early:     { tile: 'border-orange-100 bg-gradient-to-br from-orange-50 to-white',    num: 'text-orange-600', label: 'text-orange-900/60', pill: 'bg-orange-500' },
  missedIn:  { tile: 'border-sky-100 bg-gradient-to-br from-sky-50 to-white',          num: 'text-sky-600',    label: 'text-sky-900/60',    pill: 'bg-sky-500' },
  missedOut: { tile: 'border-violet-100 bg-gradient-to-br from-violet-50 to-white',    num: 'text-violet-600', label: 'text-violet-900/60', pill: 'bg-violet-500' },
}

type Scope = 'central' | 'admin' | 'branch' | 'batch-manager'

export default function AttendancePanel({ scope = 'central' }: { scope?: Scope }) {
  const supabase = createClient()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [maps, setMaps] = useState<MapRow[]>([])
  const [sheetList, setSheetList] = useState<{ sheet_batch_id: string | null; batch_name: string | null; course: string | null; center: string | null; students: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [centreId, setCentreId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [windowDays, setWindowDays] = useState(7)
  const [rows, setRows] = useState<AttRow[]>([])
  const [scheds, setScheds] = useState<Sched[]>([])
  const [planRows, setPlanRows] = useState<PlanRow[]>([])
  const [loadingBatch, setLoadingBatch] = useState(false)
  const [mapChoice, setMapChoice] = useState('')
  const [savingMap, setSavingMap] = useState(false)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [openCat, setOpenCat] = useState<string | null>(null)
  const [showDaily, setShowDaily] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      setAppUser(au)
      const [bRes, cRes, mRes, sbRes] = await Promise.all([
        supabase.from('batches').select('id, name, centre_id, batch_manager_id').order('name'),
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('batch_attendance_map').select('portal_batch_id, sheet_batch_id, batch_name'),
        supabase.rpc('attendance_batches'),
      ])
      if (bRes.error) setErr(bRes.error.message)
      if (bRes.data) setBatches(bRes.data as Batch[])
      if (cRes.data) setCentres(cRes.data as Centre[])
      if (mRes.data) setMaps(mRes.data as MapRow[])
      if (sbRes.data) setSheetList(sbRes.data as typeof sheetList)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Portal-scoped access (based on which portal renders this, not just
  //      the user's role set — a multi-role user sees the right scope per portal).
  const isPrivileged = scope === 'central' || scope === 'admin'
  const isBranch = scope === 'branch'
  const isBM = scope === 'batch-manager'
  const canMap = isPrivileged

  const allowedCentreIds = useMemo(() => {
    if (isPrivileged) return new Set(centres.map((c) => c.id))
    const set = new Set<string>(getUserCentreIds(appUser))
    if (isBranch && appUser) centres.filter((c) => c.branch_head_id === appUser.id).forEach((c) => set.add(c.id))
    return set
  }, [appUser, centres, isPrivileged, isBranch])

  const visibleBatches = useMemo(() => {
    if (isPrivileged) return batches
    if (isBM && appUser) return batches.filter((b) => b.batch_manager_id === appUser.id)
    return batches.filter((b) => allowedCentreIds.has(b.centre_id)) // branch head
  }, [batches, isPrivileged, isBM, appUser, allowedCentreIds])

  // For branch head / batch manager: the centre(s) they belong to (no picker).
  const myCentres = useMemo(() => {
    const ids = isBM ? new Set(visibleBatches.map((b) => b.centre_id)) : allowedCentreIds
    return centres.filter((c) => ids.has(c.id))
  }, [centres, isBM, visibleBatches, allowedCentreIds])

  // Privileged: batches at the picked centre. Branch/BM: all their batches (no picker).
  const batchOptions = useMemo(
    () => (isPrivileged ? visibleBatches.filter((b) => b.centre_id === centreId) : visibleBatches),
    [visibleBatches, centreId, isPrivileged]
  )

  const selectedBatch = batches.find((b) => b.id === batchId) ?? null
  const mapped = maps.find((m) => m.portal_batch_id === batchId) ?? null

  const selectCentre = (id: string) => {
    setCentreId(id)
    setBatchId(''); setRows([]); setScheds([]); setPlanRows([]); setOpenDate(null); setOpenCat(null)
  }

  const selectBatch = async (id: string) => {
    setBatchId(id)
    setRows([]); setScheds([]); setPlanRows([]); setOpenDate(null); setOpenCat(null)
    const b = batches.find((x) => x.id === id)
    if (!b) return
    const m = maps.find((mm) => mm.portal_batch_id === id)
    const target = b.name.toLowerCase()
    const auto = sheetList.find((s) => (s.sheet_batch_id ?? '').toLowerCase() === target || (s.batch_name ?? '').toLowerCase() === target)
    setMapChoice(m?.batch_name ?? auto?.batch_name ?? '')
    if (!m) return
    await loadBatchData(id, m.batch_name)
  }

  const loadBatchData = async (portalBatchId: string, sheetBatchName: string) => {
    setLoadingBatch(true)
    const since = iso(new Date(todayNoon().getTime() - 95 * 86400000))
    const [attRes, schRes, planRes] = await Promise.all([
      supabase.from('attendance').select('regno, student_name, attendance_date, first_punch_in, last_punch_out, admission_status, batch_name').eq('batch_name', sheetBatchName).gte('attendance_date', since),
      supabase.from('batch_schedules').select('day_of_week, start_time, end_time').eq('batch_id', portalBatchId),
      supabase.from('batch_planners').select('planned_date, start_time, duration_minutes').eq('batch_id', portalBatchId).gte('planned_date', since),
    ])
    if (attRes.data) setRows(attRes.data as AttRow[])
    if (schRes.data) setScheds(schRes.data as Sched[])
    if (planRes.data) setPlanRows(planRes.data as PlanRow[])
    setLoadingBatch(false)
  }

  const saveMap = async () => {
    if (!selectedBatch || !mapChoice) return
    setSavingMap(true)
    const chosen = sheetList.find((s) => s.batch_name === mapChoice)
    const { error } = await supabase.from('batch_attendance_map').upsert(
      { portal_batch_id: selectedBatch.id, batch_name: mapChoice, sheet_batch_id: chosen?.sheet_batch_id ?? null },
      { onConflict: 'portal_batch_id' }
    )
    setSavingMap(false)
    if (error) { setErr(error.message); return }
    const newMap = { portal_batch_id: selectedBatch.id, batch_name: mapChoice, sheet_batch_id: chosen?.sheet_batch_id ?? null }
    setMaps((prev) => [...prev.filter((m) => m.portal_batch_id !== selectedBatch.id), newMap])
    await loadBatchData(selectedBatch.id, mapChoice)
  }

  // ---- Derived analytics ---------------------------------------------------
  const weekdays = useMemo(() => new Set(scheds.map((s) => s.day_of_week)), [scheds])

  // Batch timing per weekday (for late-in / early-out thresholds), from the weekly schedule.
  const dayBounds = useMemo(() => {
    const map: Record<number, { start: number; end: number }> = {}
    for (const s of scheds) {
      const st = parseTimeToMin(s.start_time.slice(0, 5)) ?? 0
      const en = parseTimeToMin(s.end_time.slice(0, 5)) ?? 0
      if (!map[s.day_of_week]) map[s.day_of_week] = { start: st, end: en }
      else { map[s.day_of_week].start = Math.min(map[s.day_of_week].start, st); map[s.day_of_week].end = Math.max(map[s.day_of_week].end, en) }
    }
    return map
  }, [scheds])

  // Per-date timing from the planner lecture(s) on that exact date (preferred).
  const plannerBoundsByDate = useMemo(() => {
    const m = new Map<string, { start: number; end: number }>()
    for (const p of planRows) {
      const st = parseTimeToMin(p.start_time ? p.start_time.slice(0, 5) : null)
      if (st == null) continue
      const en = st + (p.duration_minutes || 0)
      const cur = m.get(p.planned_date)
      if (!cur) m.set(p.planned_date, { start: st, end: en })
      else { cur.start = Math.min(cur.start, st); cur.end = Math.max(cur.end, en) }
    }
    return m
  }, [planRows])

  const boundsForDate = (dt: string) => {
    const p = plannerBoundsByDate.get(dt)
    if (p) return p
    const dow = new Date(dt + 'T12:00:00').getDay()
    return dayBounds[dow] ?? null
  }

  // ACTIVE class days come from the planner (both class & test lectures are
  // materialised here) — holidays simply have no lecture, so they don't count.
  // Falls back to the weekly recurring schedule if a planner isn't attached yet.
  const usingPlanner = planRows.length > 0
  const activeDatesAll = useMemo(() => {
    const set = new Set<string>()
    const today = iso(todayNoon())
    if (planRows.length) {
      for (const p of planRows) if (p.planned_date <= today) set.add(p.planned_date)
    } else if (weekdays.size) {
      const base = todayNoon()
      for (let i = 0; i < 95; i++) { const d = new Date(base.getTime() - i * 86400000); if (weekdays.has(d.getDay())) set.add(iso(d)) }
    }
    return Array.from(set).sort().reverse()
  }, [planRows, weekdays])

  const datesInWindow = (n: number) => {
    const cutoff = iso(new Date(todayNoon().getTime() - (n - 1) * 86400000))
    return activeDatesAll.filter((d) => d >= cutoff)
  }

  const students = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) if (!m.has(r.regno)) m.set(r.regno, r.student_name)
    return m
  }, [rows])

  const byRegDate = useMemo(() => {
    const m = new Map<string, AttRow>()
    for (const r of rows) m.set(`${r.regno}|${r.attendance_date}`, r)
    return m
  }, [rows])

  const pctFor = (n: number) => {
    const dates = datesInWindow(n)
    if (dates.length === 0 || students.size === 0) return null
    let present = 0
    for (const dt of dates) for (const reg of students.keys()) {
      const row = byRegDate.get(`${reg}|${dt}`)
      if (row && row.first_punch_in) present++
    }
    return Math.round((present / (students.size * dates.length)) * 1000) / 10
  }

  const analysis = useMemo(() => {
    const dates = datesInWindow(windowDays)
    const cat = { absent: [] as Instance[], late: [] as Instance[], early: [] as Instance[], missedIn: [] as Instance[], missedOut: [] as Instance[] }
    const perDate = dates.map((dt) => {
      const bounds = boundsForDate(dt)
      const dAbsent: Instance[] = [], dLate: Instance[] = [], dEarly: Instance[] = [], dMissed: (Instance & { kind: string })[] = []
      let present = 0
      for (const [reg, name] of students) {
        const row = byRegDate.get(`${reg}|${dt}`)
        const hasIn = !!row?.first_punch_in
        const hasOut = !!row?.last_punch_out
        if (!row || (!hasIn && !hasOut)) { const it = { regno: reg, name, date: dt }; cat.absent.push(it); dAbsent.push(it); continue }
        present++
        const inMin = parseTimeToMin(row.first_punch_in)
        const outMin = parseTimeToMin(row.last_punch_out)
        if (bounds && hasIn && inMin != null && inMin > bounds.start) { const it = { regno: reg, name, date: dt, at: row.first_punch_in! }; cat.late.push(it); dLate.push(it) }
        if (bounds && hasOut && outMin != null && outMin < bounds.end) { const it = { regno: reg, name, date: dt, at: row.last_punch_out! }; cat.early.push(it); dEarly.push(it) }
        if (hasIn && !hasOut) { const it = { regno: reg, name, date: dt, at: row.first_punch_in! }; cat.missedOut.push(it); dMissed.push({ ...it, kind: 'No check-out' }) }
        if (!hasIn && hasOut) { const it = { regno: reg, name, date: dt, at: row.last_punch_out! }; cat.missedIn.push(it); dMissed.push({ ...it, kind: 'No check-in' }) }
      }
      return { dt, dow: new Date(dt + 'T12:00:00').getDay(), present, total: students.size, absent: dAbsent, late: dLate, early: dEarly, missed: dMissed }
    })
    return { dates, cat, perDate }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, planRows, scheds, windowDays, students])

  const categories = [
    { key: 'absent', label: 'Absentees', sub: 'Full day absent', items: analysis.cat.absent, timed: false },
    { key: 'late', label: 'Late Punch In', sub: 'After batch start', items: analysis.cat.late, timed: true },
    { key: 'early', label: 'Early Punch Out', sub: 'Before batch end', items: analysis.cat.early, timed: true },
    { key: 'missedIn', label: 'Missed Check-in', sub: 'Out punched, no in', items: analysis.cat.missedIn, timed: true },
    { key: 'missedOut', label: 'Missed Check-out', sub: 'In punched, no out', items: analysis.cat.missedOut, timed: true },
  ]

  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? ''
  const chip = 'inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold'
  const tile = 'rounded-2xl p-4 border shadow-sm'
  const selectCls = 'h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500'

  const roleNote = isPrivileged ? 'Pick a centre, then a batch.' : 'Choose a batch below.'
  const myCentreNames = myCentres.map((c) => c.name).join(', ')

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Attendance" description={`Live from the biometric sheet (read-only). Only active class days from the batch's planner are counted — holidays are ignored. ${roleNote}`} />

      {err && <Alert type="error">{err}</Alert>}

      {/* Branch head / batch manager are tied to their centre — no centre picker. */}
      {!isPrivileged && !loading && myCentres.length > 0 && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-xl border border-violet-100 bg-violet-50 px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-violet-500">Your centre{myCentres.length > 1 ? 's' : ''}</span>
          <span className="text-sm font-bold text-violet-900">{myCentreNames}</span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-6">
        {isPrivileged && (
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select value={centreId} onChange={(e) => selectCentre(e.target.value)} className={`${selectCls} min-w-[220px]`} disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
          <select value={batchId} onChange={(e) => selectBatch(e.target.value)} className={`${selectCls} min-w-[240px]`} disabled={loading || (isPrivileged && !centreId)}>
            <option value="">{(isPrivileged && !centreId) ? 'Select a centre first' : batchOptions.length === 0 ? 'No batches' : 'Select a batch'}</option>
            {batchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}{!isPrivileged && myCentres.length > 1 && b.centre_id ? ` — ${centreName(b.centre_id)}` : ''}</option>)}
          </select>
        </div>
        {mapped && (
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <button key={w} onClick={() => setWindowDays(w)} className={`h-11 px-3 rounded-xl text-sm font-semibold transition-colors ${windowDays === w ? 'bg-violet-600 text-white' : 'bg-white border border-neutral-200 text-neutral-600 hover:border-violet-300'}`}>{w}d</button>
            ))}
          </div>
        )}
      </div>

      {!batchId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a batch to see its attendance.</Card>
      ) : !mapped ? (
        canMap ? (
          <Card className="p-6">
            <h3 className="font-bold text-neutral-950 mb-1">Link this batch to attendance data</h3>
            <p className="text-sm text-neutral-500 mb-4">Choose which batch in the attendance sheet corresponds to <span className="font-semibold">{selectedBatch?.name}</span>. This connects the planner (active class days) with the biometric punches.</p>
            <div className="flex flex-wrap gap-3 items-center">
              <select value={mapChoice} onChange={(e) => setMapChoice(e.target.value)} className={`${selectCls} min-w-[360px]`}>
                <option value="">Select attendance batch</option>
                {sheetList.filter((s) => s.batch_name).map((s) => (
                  <option key={s.batch_name} value={s.batch_name!}>
                    {(s.sheet_batch_id || s.batch_name)}{s.course ? ` · ${s.course}` : ''}{s.center ? ` · ${s.center}` : ''} · {s.students} students
                  </option>
                ))}
              </select>
              <button onClick={saveMap} disabled={!mapChoice || savingMap} className="h-11 px-5 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 disabled:from-neutral-300 disabled:to-neutral-300 text-white shadow-md shadow-violet-500/25">{savingMap ? 'Linking…' : 'Link'}</button>
            </div>
            <p className="text-xs text-neutral-400 mt-3">Tip: match by course + centre + student count. The code shown is the attendance system&apos;s batch id.</p>
            {sheetList.length === 0 && <p className="text-xs text-amber-600 mt-2">No attendance data found yet. Run <code>npm run sync-attendance</code> first.</p>}
          </Card>
        ) : (
          <Alert type="info">This batch isn&apos;t linked to attendance data yet. Ask the Central Team to link it under Central → Attendance.</Alert>
        )
      ) : loadingBatch ? (
        <Card className="p-10 text-center text-neutral-400">Loading attendance…</Card>
      ) : activeDatesAll.length === 0 ? (
        <Alert type="info">No planner (or weekly schedule) found for this batch, so there are no class days to measure against. Attach a planner in Batch Planner first.</Alert>
      ) : students.size === 0 ? (
        <Alert type="info">No attendance rows found for “{mapped.batch_name}”. Re-check the mapping or run the sync.</Alert>
      ) : (
        <div className="space-y-6">
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className={`${tile} border-violet-100 bg-gradient-to-br from-violet-50 to-white`}>
              <div className="text-3xl font-black text-violet-600">{students.size}</div>
              <div className="text-xs font-medium text-violet-900/60 mt-1">Total Students</div>
            </div>
            <div className={`${tile} border-emerald-100 bg-gradient-to-br from-emerald-50 to-white`}>
              <div className="text-3xl font-black text-emerald-600">{pctFor(windowDays) ?? '—'}%</div>
              <div className="text-xs font-medium text-emerald-900/60 mt-1">Present · last {windowDays}d</div>
            </div>
            <div className={`${tile} border-sky-100 bg-gradient-to-br from-sky-50 to-white`}>
              <div className="text-3xl font-black text-sky-600">{analysis.dates.length}</div>
              <div className="text-xs font-medium text-sky-900/60 mt-1">Active class days · {windowDays}d</div>
            </div>
            <div className={`${tile} border-rose-100 bg-gradient-to-br from-rose-50 to-white`}>
              <div className="text-3xl font-black text-rose-600">{analysis.cat.absent.length}</div>
              <div className="text-xs font-medium text-rose-900/60 mt-1">Absentee instances · {windowDays}d</div>
            </div>
          </div>

          {/* Present % across windows */}
          <Card className="p-5">
            <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3">Present % over time</h4>
            <div className="flex flex-wrap gap-2">
              {WINDOWS.map((w) => {
                const p = pctFor(w)
                return <span key={w} className={`${chip} ${p == null ? 'bg-neutral-100 text-neutral-400' : p >= 75 ? 'bg-emerald-50 text-emerald-700' : p >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>{w}d: <b className="ml-1">{p == null ? '—' : p + '%'}</b></span>
              })}
            </div>
            <p className="text-xs text-neutral-400 mt-3">{usingPlanner ? 'Class days derived from this batch’s planner.' : 'No planner attached — falling back to the weekly schedule for class days.'}</p>
          </Card>

          {/* Issue categories — the heart of the view */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Issues · last {windowDays} days</h4>
              <span className="text-xs text-neutral-400">Tap a card for names</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {categories.map((c) => {
                const st = CAT_STYLES[c.key]
                const active = openCat === c.key
                return (
                  <button
                    key={c.key}
                    onClick={() => setOpenCat(active ? null : c.key)}
                    className={`${tile} text-left transition-all ${st.tile} ${active ? 'ring-2 ring-violet-400' : 'hover:shadow-md'}`}
                  >
                    <div className={`text-3xl font-black ${st.num}`}>{c.items.length}</div>
                    <div className="text-sm font-semibold text-neutral-800 mt-1">{c.label}</div>
                    <div className={`text-[11px] ${st.label}`}>{c.sub}</div>
                  </button>
                )
              })}
            </div>

            {openCat && (() => {
              const c = categories.find((x) => x.key === openCat)!
              const st = CAT_STYLES[c.key]
              return (
                <Card className="mt-3 overflow-hidden">
                  <div className="px-5 py-3 border-b border-neutral-100 flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${st.pill}`} />
                    <h5 className="font-semibold text-neutral-950">{c.label}</h5>
                    <span className="text-xs text-neutral-400">· {c.items.length} instance(s) in last {windowDays}d</span>
                  </div>
                  {c.items.length === 0 ? (
                    <p className="p-6 text-sm text-neutral-400">None 🎉</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider">
                            <th className="px-5 py-2 font-semibold">Student</th>
                            <th className="px-3 py-2 font-semibold">Reg no.</th>
                            <th className="px-3 py-2 font-semibold">Date</th>
                            {c.timed && <th className="px-3 py-2 font-semibold">Punch</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100">
                          {c.items.map((it, i) => (
                            <tr key={`${it.regno}|${it.date}|${i}`} className="hover:bg-neutral-50/60">
                              <td className="px-5 py-2 font-medium text-neutral-900">{it.name}</td>
                              <td className="px-3 py-2 font-mono text-xs text-neutral-500">{it.regno}</td>
                              <td className="px-3 py-2 text-neutral-600">{fmtDate(it.date)}</td>
                              {c.timed && <td className="px-3 py-2 text-neutral-500">{it.at ?? '—'}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )
            })()}
          </div>

          {/* Day-by-day breakdown (secondary) */}
          <Card className="overflow-hidden">
            <button onClick={() => setShowDaily((v) => !v)} className="w-full px-5 py-4 border-b border-neutral-100 flex items-center justify-between hover:bg-neutral-50">
              <h4 className="font-semibold text-neutral-950">Day-by-day · {analysis.dates.length} class day(s) in last {windowDays}d</h4>
              <span className="text-neutral-400 text-sm">{showDaily ? 'Hide ▲' : 'Show ▼'}</span>
            </button>
            {showDaily && (
              analysis.perDate.length === 0 ? (
                <p className="p-6 text-sm text-neutral-400">No class days in this window (per the planner).</p>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {analysis.perDate.map((d) => {
                    const pct = d.total ? Math.round((d.present / d.total) * 100) : 0
                    const open = openDate === d.dt
                    return (
                      <div key={d.dt}>
                        <button onClick={() => setOpenDate(open ? null : d.dt)} className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-violet-50/50 text-left">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-semibold text-neutral-900 min-w-[130px]">{fmtDate(d.dt)}</span>
                            <span className="text-xs text-neutral-400">{DAYS_FULL[d.dow]}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-emerald-700 font-semibold">{d.present} present</span>
                            {d.absent.length > 0 && <span className="text-rose-700 font-semibold">{d.absent.length} absent</span>}
                            {d.late.length > 0 && <span className="text-amber-700">{d.late.length} late</span>}
                            <span className={`w-12 text-right font-bold ${pct >= 75 ? 'text-emerald-600' : pct >= 50 ? 'text-amber-600' : 'text-rose-600'}`}>{pct}%</span>
                            <span className="text-neutral-400">{open ? '▲' : '▼'}</span>
                          </div>
                        </button>
                        {open && (
                          <div className="px-5 pb-4 pt-1 grid md:grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-xs font-bold text-rose-600 uppercase tracking-wider mb-1">Absent ({d.absent.length})</p>
                              {d.absent.length === 0 ? <p className="text-neutral-400 text-xs">None 🎉</p> : (
                                <ul className="space-y-0.5">{d.absent.map((s) => <li key={s.regno} className="text-neutral-700"><span className="font-mono text-xs text-neutral-400">{s.regno}</span> {s.name}</li>)}</ul>
                              )}
                            </div>
                            <div className="space-y-3">
                              {d.late.length > 0 && <div><p className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-1">Late in ({d.late.length})</p><ul className="space-y-0.5">{d.late.map((s) => <li key={s.regno} className="text-neutral-700">{s.name} <span className="text-xs text-neutral-400">@ {s.at}</span></li>)}</ul></div>}
                              {d.early.length > 0 && <div><p className="text-xs font-bold text-orange-600 uppercase tracking-wider mb-1">Early out ({d.early.length})</p><ul className="space-y-0.5">{d.early.map((s) => <li key={s.regno} className="text-neutral-700">{s.name} <span className="text-xs text-neutral-400">@ {s.at}</span></li>)}</ul></div>}
                              {d.missed.length > 0 && <div><p className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-1">Missed punch ({d.missed.length})</p><ul className="space-y-0.5">{d.missed.map((s) => <li key={s.regno} className="text-neutral-700">{s.name} <span className="text-xs text-neutral-400">— {s.kind}</span></li>)}</ul></div>}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            )}
          </Card>

          {canMap && (
            <p className="text-xs text-neutral-400">Linked to attendance batch “{mapped.batch_name}”. <button className="text-violet-600 font-semibold hover:underline" onClick={() => setMaps((prev) => prev.filter((m) => m.portal_batch_id !== batchId))}>Change link</button></p>
          )}
        </div>
      )}
    </div>
  )
}
