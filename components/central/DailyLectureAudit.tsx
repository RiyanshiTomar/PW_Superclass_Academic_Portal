'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

// ─── Types ───────────────────────────────────────────────────────────────────

type Lecture = {
  planner_id: string
  planned_date: string
  start_time: string | null
  duration_minutes: number | null
  batch_id: string
  batch_name: string
  batch_owner_id: string | null
  centre_name: string
  subject_name: string
  faculty_name: string
  chapter: string | null
  topic_name: string | null
  // audit fields (null = not yet audited)
  audit_id: string | null
  lecture_link: string
  topic_check: boolean
  duration_check: boolean
  ppt_check: boolean
  remarks: string
  audit_status: 'pending' | 'audited' | 'flagged'
}

type DateGroup = {
  date: string
  lectures: Lecture[]
  pendingCount: number
}

type Centre = { id: string; name: string }
type Batch  = { id: string; name: string; centre_id: string; batch_owner_id: string | null }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (t: string | null) => t ? t.slice(0, 5) : '—'
const fmtDate = (d: string) =>
  new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
const isToday = (d: string) => d === new Date().toISOString().split('T')[0]

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DailyLectureAudit() {
  const supabase = createClient()

  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [isOwner, setIsOwner]     = useState(false) // logged-in user is a batch owner

  const [lectures,  setLectures]  = useState<Lecture[]>([])
  const [centres,   setCentres]   = useState<Centre[]>([])
  const [batches,   setBatches]   = useState<Batch[]>([])
  const [owners,    setOwners]    = useState<{ id: string; full_name: string }[]>([])
  const [carryPending, setCarryPending] = useState(0) // pending from before today

  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState('')
  const [message,   setMessage]   = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Selected date — default today
  const todayISO = new Date().toISOString().split('T')[0]
  const [selectedDate, setSelectedDate] = useState(todayISO)

  const shiftDate = (delta: number) => {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + delta)
    setSelectedDate(d.toISOString().split('T')[0])
  }

  // Filters
  const [filterCentre, setFilterCentre] = useState('')
  const [filterBatch,  setFilterBatch]  = useState('')
  const [filterOwner,  setFilterOwner]  = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  // Inline edit state keyed by planner_id
  const [edits, setEdits] = useState<Record<string, {
    lecture_link: string
    topic_check: boolean
    duration_check: boolean
    ppt_check: boolean
    remarks: string
  }>>({})

  // ─── Load ──────────────────────────────────────────────────────────────────

  const load = async (date: string) => {
    setLoading(true)
    setMessage(null)

    // Build batch_id list to filter at DB level if filters are set
    let batchIdsToQuery: string[] | null = null
    if (filterBatch) {
      batchIdsToQuery = [filterBatch]
    } else if (filterOwner) {
      // Filter by specific owner
      batchIdsToQuery = batches.filter(b => b.batch_owner_id === filterOwner).map(b => b.id)
    } else if (filterCentre) {
      batchIdsToQuery = batches.filter(b => b.centre_id === filterCentre).map(b => b.id)
    } else if (isOwner && appUserId) {
      // Logged-in user is an owner — auto show only their batches
      batchIdsToQuery = batches.filter(b => b.batch_owner_id === appUserId).map(b => b.id)
    }

    // Fetch only the selected date's lectures
    let query = supabase
      .from('batch_planners')
      .select(`
        id, planned_date, start_time, duration_minutes,
        chapter, topic_name, batch_id, subject_id,
        batches(id, name, centre_id, batch_owner_id, centres(id, name)),
        subjects(id, name),
        app_users!batch_planners_faculty_id_fkey(id, full_name)
      `)
      .eq('is_buffer', false)
      .eq('planned_date', date)
      .neq('status', 'cancelled')
      .order('start_time', { ascending: true })

    if (batchIdsToQuery && batchIdsToQuery.length > 0) {
      query = query.in('batch_id', batchIdsToQuery)
    }

    const { data: planners, error: pErr } = await query

    if (pErr) {
      setMessage({ type: 'error', text: 'Could not load lectures: ' + pErr.message })
      setLoading(false)
      return
    }

    if (!planners || planners.length === 0) {
      setLectures([])
      setEdits({})
      setLoading(false)
      return
    }

    // Filter out only entries with no start_time at all — everything else is valid
    const validPlanners = planners.filter(p => !!p.start_time)

    // Fetch existing audit rows
    const ids = validPlanners.map(p => p.id)
    const { data: audits } = await supabase
      .from('lecture_audits')
      .select('id, batch_planner_id, lecture_link, topic_check, duration_check, ppt_check, remarks, audit_status')
      .in('batch_planner_id', ids)

    const auditMap = new Map<string, typeof audits extends (infer T)[] | null ? T : never>()
    for (const a of (audits ?? [])) auditMap.set(a.batch_planner_id, a)

    // Merge
    const merged: Lecture[] = validPlanners.map(p => {
      const batch   = one(p.batches  as never) as { id: string; name: string; centre_id: string; batch_owner_id: string | null; centres: unknown } | null
      const centre  = one(batch?.centres as never) as { name: string } | null
      const subj    = one(p.subjects as never) as { name: string } | null
      const fac     = one(p.app_users as never) as { full_name: string } | null
      const a       = auditMap.get(p.id)

      return {
        planner_id:      p.id,
        planned_date:    p.planned_date,
        start_time:      p.start_time,
        duration_minutes: p.duration_minutes,
        batch_id:        p.batch_id,
        batch_name:      batch?.name      ?? '—',
        batch_owner_id:  batch?.batch_owner_id ?? null,
        centre_name:     centre?.name     ?? '—',
        subject_name:    subj?.name       ?? '—',
        faculty_name:    fac?.full_name   ?? '—',
        chapter:         p.chapter,
        topic_name:      p.topic_name,
        audit_id:        a?.id            ?? null,
        lecture_link:    a?.lecture_link  ?? '',
        topic_check:     a?.topic_check   ?? false,
        duration_check:  a?.duration_check ?? false,
        ppt_check:       a?.ppt_check      ?? false,
        remarks:         a?.remarks        ?? '',
        audit_status:    (a?.audit_status as Lecture['audit_status']) ?? 'pending',
      }
    })

    setLectures(merged)

    // Init edit state
    const initEdits: typeof edits = {}
    merged.forEach(l => {
      initEdits[l.planner_id] = {
        lecture_link:   l.lecture_link,
        topic_check:    l.topic_check,
        duration_check: l.duration_check,
        ppt_check:      l.ppt_check,
        remarks:        l.remarks,
      }
    })
    setEdits(initEdits)

    // ── Carry-forward pending: count unaudited lectures from 19 Aug up to (but not including) selected date
    const START_DATE = '2026-08-19' // audit start date
    const todayStr   = new Date().toISOString().split('T')[0]

    // Only show earlier pending when viewing a date after the start date
    if (date > START_DATE) {
      let pastQuery = supabase
        .from('batch_planners')
        .select('id')
        .eq('is_buffer', false)
        .neq('status', 'cancelled')
        .gte('planned_date', START_DATE)   // from audit start
        .lt('planned_date', date)          // up to (not including) selected date

      if (batchIdsToQuery && batchIdsToQuery.length > 0) {
        pastQuery = pastQuery.in('batch_id', batchIdsToQuery)
      }

      const { data: pastPlanners } = await pastQuery
      if (pastPlanners && pastPlanners.length > 0) {
        const pastIds = pastPlanners.map((p: { id: string }) => p.id)
        const { data: pastAudits } = await supabase
          .from('lecture_audits')
          .select('batch_planner_id, audit_status')
          .in('batch_planner_id', pastIds)
        // A lecture is "done" if it's audited or flagged — only truly pending ones carry forward
        const donePastIds = new Set(
          (pastAudits ?? [])
            .filter((a: { audit_status: string }) => a.audit_status !== 'pending')
            .map((a: { batch_planner_id: string }) => a.batch_planner_id)
        )
        setCarryPending(pastIds.length - donePastIds.size)
      } else {
        setCarryPending(0)
      }
    } else {
      setCarryPending(0) // on or before start date → no earlier pending
    }

    setLoading(false)
  }

  // ─── Init (centres + batches + user) — runs once ──────────────────────────
  const [inited, setInited] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const au = await getAppUser(supabase, user)
        const uid = au?.id ?? null
        setAppUserId(uid)
        const [centresRes, batchesRes, ownersRes] = await Promise.all([
          supabase.from('centres').select('id, name').order('name'),
          supabase.from('batches').select('id, name, centre_id, batch_owner_id').neq('status', 'Merged').order('name'),
          supabase.rpc('get_central_team_members'),
        ])
        const cl = (centresRes.data ?? []) as Centre[]
        const bl = (batchesRes.data ?? []) as Batch[]
        setCentres(cl)
        setBatches(bl)
        setOwners((ownersRes.data ?? []) as { id: string; full_name: string }[])
        // If this user owns any batch, auto-filter to their batches only
        const ownsAny = bl.some(b => b.batch_owner_id === uid)
        setIsOwner(ownsAny)
      }
      setInited(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Load lectures — reruns when date or filters change ────────────────────
  useEffect(() => {
    if (!inited) return
    load(selectedDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inited, selectedDate, filterBatch, filterCentre, filterOwner])

  // ─── Filtered + grouped ────────────────────────────────────────────────────

  const filteredBatches = useMemo(
    () => batches.filter(b => !filterCentre || b.centre_id === filterCentre),
    [batches, filterCentre]
  )

  const filtered = useMemo(() => {
    return lectures.filter(l => {
      if (filterStatus && l.audit_status !== filterStatus) return false
      return true
    })
  }, [lectures, filterStatus])

  // Group by date — with single-date load this is just one group, but keeps the structure clean
  const dateGroups = useMemo((): DateGroup[] => {
    const map = new Map<string, Lecture[]>()
    for (const l of filtered) {
      const arr = map.get(l.planned_date) ?? []
      arr.push(l)
      map.set(l.planned_date, arr)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, lectures]) => ({
        date,
        lectures,
        pendingCount: lectures.filter(l => l.audit_status === 'pending').length,
      }))
  }, [filtered])

  // Overall stats
  const stats = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const todayLecs = filtered.filter(l => l.planned_date === today)
    return {
      todayTotal:   todayLecs.length,
      todayPending: todayLecs.filter(l => l.audit_status === 'pending').length,
      totalPending: filtered.filter(l => l.audit_status === 'pending').length,
      totalAudited: filtered.filter(l => l.audit_status === 'audited').length,
      totalFlagged: filtered.filter(l => l.audit_status === 'flagged').length,
    }
  }, [filtered])

  // ─── Save ──────────────────────────────────────────────────────────────────

  const save = async (lecture: Lecture) => {
    const pid = lecture.planner_id
    setSaving(pid)
    setMessage(null)

    const e = edits[pid]
    if (!e) { setSaving(''); return }

    const allChecked = e.topic_check && e.duration_check && e.ppt_check
    const anyChecked = e.topic_check || e.duration_check || e.ppt_check
    const hasContent = e.lecture_link.trim() || e.remarks.trim()

    let audit_status: Lecture['audit_status'] = 'pending'
    if (allChecked) audit_status = 'audited'
    else if (anyChecked || hasContent) audit_status = 'flagged'

    const row = {
      batch_planner_id: pid,
      batch_id:         lecture.batch_id,
      centre_id:        batches.find(b => b.id === lecture.batch_id)?.centre_id ?? null,
      subject_id:       null as string | null,
      faculty_id:       null as string | null,
      lecture_date:     lecture.planned_date,
      lecture_link:     e.lecture_link.trim() || null,
      topic_check:      e.topic_check,
      duration_check:   e.duration_check,
      ppt_check:        e.ppt_check,
      remarks:          e.remarks.trim() || null,
      audit_status,
      audited_by:       appUserId,   // app_users.id — correct FK
      audited_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }

    const { error } = await supabase
      .from('lecture_audits')
      .upsert(row, { onConflict: 'batch_planner_id' })

    if (error) {
      setMessage({ type: 'error', text: 'Save failed: ' + error.message })
    } else {
      setMessage({
        type: 'success',
        text: audit_status === 'audited' ? '✅ Audited!'
            : audit_status === 'flagged' ? '🚩 Flagged.'
            : '⏳ Saved.',
      })
      // Update local state
      setLectures(prev => prev.map(l =>
        l.planner_id !== pid ? l : { ...l, audit_status, ...e }
      ))
    }
    setSaving('')
  }

  // ─── Status badge ──────────────────────────────────────────────────────────

  const statusBadge = (s: Lecture['audit_status']) => {
    const map = {
      pending: 'bg-amber-100 text-amber-800 border-amber-300',
      audited: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      flagged: 'bg-red-100 text-red-800 border-red-300',
    }
    const icon = { pending: '⏳', audited: '✅', flagged: '🚩' }
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${map[s]}`}>
        {icon[s]} {s.charAt(0).toUpperCase() + s.slice(1)}
      </span>
    )
  }

  const inputCls  = 'w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400'
  const thCls     = 'px-3 py-2 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap border-b border-neutral-200 bg-neutral-50'
  const tdCls     = 'px-3 py-2 text-sm text-neutral-800 border-b border-neutral-100 align-top'

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title="Daily Lecture Audit"
        description="One day at a time. Verify each class, add the lecture link, and mark checks."
      />

      {message && <Alert type={message.type}>{message.text}</Alert>}

      {/* ── Date navigation ── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <BtnSecondary onClick={() => shiftDate(-1)}>← Prev</BtnSecondary>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          />
          <BtnSecondary onClick={() => setSelectedDate(todayISO)}>Today</BtnSecondary>
          <BtnSecondary onClick={() => shiftDate(1)}>Next →</BtnSecondary>
          <span className="text-sm font-semibold text-neutral-700 ml-2">
            {isToday(selectedDate) ? '📅 Today — ' : ''}{fmtDate(selectedDate)}
          </span>
        </div>
      </Card>

      {/* ── Filters ── */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select
              value={filterCentre}
              onChange={e => { setFilterCentre(e.target.value); setFilterBatch('') }}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]"
            >
              <option value="">All centres</option>
              {centres.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch</label>
            <select
              value={filterBatch}
              onChange={e => setFilterBatch(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]"
            >
              <option value="">All batches</option>
              {filteredBatches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch Owner</label>
            <select
              value={filterOwner}
              onChange={e => { setFilterOwner(e.target.value); setFilterBatch(''); setFilterCentre('') }}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]"
            >
              <option value="">All owners</option>
              {owners
                .filter(o => batches.some(b => b.batch_owner_id === o.id))
                .map(o => (
                  <option key={o.id} value={o.id}>{o.full_name}</option>
                ))
              }
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Status</label>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              <option value="">All</option>
              <option value="pending">⏳ Pending</option>
              <option value="audited">✅ Audited</option>
              <option value="flagged">🚩 Flagged</option>
            </select>
          </div>
          <BtnSecondary onClick={() => { setFilterCentre(''); setFilterBatch(''); setFilterOwner(''); setFilterStatus('') }}>
            Clear
          </BtnSecondary>
        </div>
      </Card>

      {/* ── Stats strip ── */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(() => {
            const todayPending = filtered.filter(l => l.audit_status === 'pending').length
            const totalPending = todayPending + carryPending
            return [
              { label: 'Today\'s classes',  value: filtered.length,                                                           color: 'text-neutral-700',  highlight: false },
              { label: 'Today pending',     value: todayPending,                                                                color: 'text-amber-600',    highlight: false },
              { label: 'Earlier pending',   value: carryPending,                                                                color: carryPending > 0 ? 'text-orange-600' : 'text-neutral-400', highlight: carryPending > 0 },
              { label: 'Total pending',     value: totalPending,                                                                color: totalPending > 0 ? 'text-red-600' : 'text-neutral-400',    highlight: false },
              { label: 'Done today ✓',      value: filtered.filter(l => l.audit_status === 'audited' || l.audit_status === 'flagged').length, color: 'text-emerald-600', highlight: false },
            ].map(stat => (
              <Card key={stat.label} className={`p-4 text-center ${stat.highlight ? 'border-orange-300 bg-orange-50' : ''}`}>
                <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
                <div className="text-xs text-neutral-500 mt-1">{stat.label}</div>
              </Card>
            ))
          })()}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <Card className="p-10 text-center text-neutral-400">Loading lectures…</Card>
      )}

      {/* ── Empty ── */}
      {!loading && filtered.length === 0 && (
        <Card className="p-10 text-center text-neutral-400">
          No lectures scheduled for {fmtDate(selectedDate)}.
        </Card>
      )}

      {/* ── Excel table — all classes for the selected date ── */}
      {!loading && filtered.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left min-w-[1100px]">
            <thead>
              <tr>
                <th className={thCls}>Time</th>
                <th className={thCls}>Batch</th>
                <th className={thCls}>Centre</th>
                <th className={thCls}>Subject</th>
                <th className={thCls}>Faculty</th>
                <th className={thCls}>Chapter · Topic</th>
                <th className={thCls + ' min-w-[180px]'}>Lecture Link</th>
                <th className={thCls + ' text-center'}>Topic ✓</th>
                <th className={thCls + ' text-center'}>Duration ✓</th>
                <th className={thCls + ' text-center'}>PPT ✓</th>
                <th className={thCls + ' min-w-[150px]'}>Remarks</th>
                <th className={thCls + ' text-center'}>Status</th>
                <th className={thCls + ' text-center'}>Save</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lecture => {
                const e   = edits[lecture.planner_id] ?? { lecture_link: '', topic_check: false, duration_check: false, ppt_check: false, remarks: '' }
                const all = e.topic_check && e.duration_check && e.ppt_check
                const any = e.topic_check || e.duration_check || e.ppt_check
                const hasContent = e.lecture_link.trim() || e.remarks.trim()
                const rowBg =
                  lecture.audit_status === 'audited' ? 'bg-emerald-50/40' :
                  lecture.audit_status === 'flagged' ? 'bg-red-50/40' : ''

                return (
                  <tr key={lecture.planner_id} className={rowBg + ' hover:bg-neutral-50/60'}>
                    <td className={tdCls + ' whitespace-nowrap font-medium'}>
                      {fmt(lecture.start_time)}
                      {lecture.duration_minutes && <span className="text-neutral-400 text-xs ml-1">({lecture.duration_minutes}m)</span>}
                    </td>
                    <td className={tdCls + ' whitespace-nowrap font-medium'}>{lecture.batch_name}</td>
                    <td className={tdCls + ' whitespace-nowrap text-neutral-500'}>{lecture.centre_name}</td>
                    <td className={tdCls + ' whitespace-nowrap'}>{lecture.subject_name}</td>
                    <td className={tdCls + ' whitespace-nowrap text-neutral-600'}>{lecture.faculty_name}</td>
                    <td className={tdCls}>
                      {lecture.chapter && <div className="text-xs text-neutral-500">{lecture.chapter}</div>}
                      <div className="font-medium">{lecture.topic_name || <span className="text-neutral-300 italic">Not set</span>}</div>
                    </td>
                    <td className={tdCls}>
                      <input type="url" value={e.lecture_link}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], lecture_link: ev.target.value } }))}
                        placeholder="https://youtube.com/…" className={inputCls} />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.topic_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], topic_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.duration_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], duration_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.ppt_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], ppt_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls}>
                      <input type="text" value={e.remarks}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], remarks: ev.target.value } }))}
                        placeholder="Notes…" className={inputCls} />
                    </td>
                    <td className={tdCls + ' text-center'}>{statusBadge(lecture.audit_status)}</td>
                    <td className={tdCls + ' text-center'}>
                      <button onClick={() => save(lecture)} disabled={saving === lecture.planner_id}
                        className={`px-3 py-1 text-xs font-semibold rounded-lg text-white disabled:opacity-50 ${
                          all ? 'bg-emerald-600 hover:bg-emerald-700' :
                          (any || hasContent) ? 'bg-red-500 hover:bg-red-600' :
                          'bg-violet-600 hover:bg-violet-700'
                        }`}>
                        {saving === lecture.planner_id ? '…' : all ? '✅ Save' : (any || hasContent) ? '🚩 Save' : 'Save'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
