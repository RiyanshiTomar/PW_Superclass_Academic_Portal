'use client'

import { Fragment, useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all'
import { toMinutes, weeklySlotActiveOn } from '@/lib/utils'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

// ─── Types ───────────────────────────────────────────────────────────────────

type Lecture = {
  key: string                // planner id, or `slot:<schedule id>` when no planner row exists
  planner_id: string | null
  // planned   = a real planner lecture
  // buffer    = the weekly class ran on a reserved buffer slot (no topic planned)
  // unplanned = the weekly class has no planner row at all
  kind: 'planned' | 'buffer' | 'unplanned'
  planned_date: string
  start_time: string | null
  duration_minutes: number | null
  batch_id: string
  batch_name: string
  batch_owner_id: string | null
  centre_name: string
  subject_id: string | null
  subject_name: string
  faculty_id: string | null
  faculty_name: string
  classroom_id: string | null
  link_id: string | null
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

type PlannerRow = {
  id: string; planned_date: string; start_time: string | null; duration_minutes: number; is_buffer: boolean; status: string
  chapter: string | null; topic_name: string | null; batch_id: string; subject_id: string | null; faculty_id: string | null
  classroom_id: string | null; link_id: string | null; batches: unknown; subjects: unknown; app_users: unknown
}
type SlotRow = {
  id: string; batch_id: string; subject_id: string | null; faculty_id: string | null; classroom_id: string | null
  start_time: string; end_time: string; effective_from: string | null; effective_to: string | null
  batches: unknown; subjects: unknown; app_users: unknown
}
type AuditRow = {
  id: string; batch_planner_id: string; lecture_link: string | null; topic_check: boolean; duration_check: boolean
  ppt_check: boolean; remarks: string | null; audit_status: string
}
type PageRes<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

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

  // Inline edit state keyed by lecture key. chapter/topic are only used for a
  // class that isn't in the planner (what was actually taught).
  const [edits, setEdits] = useState<Record<string, {
    lecture_link: string
    topic_check: boolean
    duration_check: boolean
    ppt_check: boolean
    remarks: string
    chapter: string
    topic: string
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

    // What actually runs on this date = what the Calendar shows: every weekly
    // slot active on the date (its segment + batch dates), matched to the
    // planner row of that batch+subject. A slot whose planner row is a BUFFER
    // (or that has no planner row at all) is still a real class — it shows up
    // as a "Buffer class" so it can be audited; a cancelled row hides it.
    // Planner rows on a date with no active slot for their subject are NOT
    // shown — same as the Calendar, which only shows what is scheduled now.
    const dow = new Date(date + 'T12:00:00').getDay()
    const plannerCols = `
        id, planned_date, start_time, duration_minutes, is_buffer, status,
        chapter, topic_name, batch_id, subject_id, faculty_id, classroom_id, link_id,
        batches(id, name, centre_id, batch_owner_id, centres(id, name)),
        subjects(id, name),
        app_users!batch_planners_faculty_id_fkey(id, full_name)
      `
    const slotCols = `
        id, batch_id, subject_id, faculty_id, classroom_id, start_time, end_time, effective_from, effective_to,
        batches(id, name, centre_id, batch_owner_id, start_date, end_date, status, centres(id, name)),
        subjects(id, name),
        app_users(id, full_name)
      `
    const scoped = batchIdsToQuery && batchIdsToQuery.length > 0 ? batchIdsToQuery : null
    if (batchIdsToQuery && batchIdsToQuery.length === 0) {
      // A filter that matches no batch → nothing to audit.
      setLectures([]); setEdits({}); setCarryPending(0); setLoading(false)
      return
    }
    const [pRes, sRes] = await Promise.all([
      scoped
        ? fetchAllIn<PlannerRow>(scoped, (chunk, from, to) => supabase.from('batch_planners').select(plannerCols).eq('planned_date', date).in('batch_id', chunk).order('id').range(from, to) as unknown as PageRes<PlannerRow>)
        : fetchAll<PlannerRow>((from, to) => supabase.from('batch_planners').select(plannerCols).eq('planned_date', date).order('id').range(from, to) as unknown as PageRes<PlannerRow>),
      scoped
        ? fetchAllIn<SlotRow>(scoped, (chunk, from, to) => supabase.from('batch_schedules').select(slotCols).eq('day_of_week', dow).in('batch_id', chunk).order('id').range(from, to) as unknown as PageRes<SlotRow>)
        : fetchAll<SlotRow>((from, to) => supabase.from('batch_schedules').select(slotCols).eq('day_of_week', dow).order('id').range(from, to) as unknown as PageRes<SlotRow>),
    ])

    if (pRes.error || sRes.error) {
      setMessage({ type: 'error', text: 'Could not load lectures: ' + (pRes.error ?? sRes.error) })
      setLoading(false)
      return
    }

    const planners = pRes.data
    const slots = sRes.data.filter((s) => weeklySlotActiveOn(s, date))

    // Match each active weekly slot to a planner row of the same batch+subject
    // (closest start time — planner rows can be a few minutes off the slot).
    const used = new Set<string>()
    type Pick = { kind: Lecture['kind']; p: PlannerRow | null; slot: SlotRow | null }
    const picks: Pick[] = []
    const mins = (t: string | null) => (t ? toMinutes(t.slice(0, 5)) : 0)
    for (const s of [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
      const cands = planners.filter((p) => !used.has(p.id) && p.batch_id === s.batch_id && p.subject_id === s.subject_id)
      // Prefer a real lecture, then a cancellation marker, then a buffer.
      const rank = (p: PlannerRow) => (!p.is_buffer && p.status !== 'cancelled' ? 0 : p.status === 'cancelled' ? 1 : 2)
      cands.sort((a, b) => rank(a) - rank(b) || Math.abs(mins(a.start_time) - mins(s.start_time)) - Math.abs(mins(b.start_time) - mins(s.start_time)))
      const p = cands[0] ?? null
      if (p) used.add(p.id)
      if (p?.status === 'cancelled') continue // class cancelled for this date
      if (p && !p.is_buffer) picks.push({ kind: 'planned', p, slot: s })
      else picks.push({ kind: p ? 'buffer' : 'unplanned', p, slot: s })
    }

    if (picks.length === 0) {
      setLectures([])
      setEdits({})
    } else {
      // Existing audit rows
      const ids = picks.map((x) => x.p?.id).filter((x): x is string => !!x)
      const { data: audits } = await fetchAllIn<AuditRow>(ids, (chunk, from, to) => supabase
        .from('lecture_audits')
        .select('id, batch_planner_id, lecture_link, topic_check, duration_check, ppt_check, remarks, audit_status')
        .in('batch_planner_id', chunk).order('id').range(from, to))
      const auditMap = new Map<string, AuditRow>()
      for (const a of audits) auditMap.set(a.batch_planner_id, a)

      const merged: Lecture[] = picks.map(({ kind, p, slot }) => {
        const src = (p ?? slot)!
        const batch  = one((slot ?? p)!.batches as never) as { id: string; name: string; centre_id: string; batch_owner_id: string | null; centres: unknown } | null
        const centre = one(batch?.centres as never) as { name: string } | null
        const subj   = one(src.subjects as never) as { name: string } | null
        const fac    = one((kind === 'planned' ? p!.app_users : slot?.app_users ?? p?.app_users) as never) as { full_name: string } | null
        const a      = p ? auditMap.get(p.id) : undefined
        const start  = kind === 'planned' ? p!.start_time : slot!.start_time
        return {
          key:             p ? p.id : `slot:${slot!.id}`,
          planner_id:      p?.id ?? null,
          kind,
          planned_date:    date,
          start_time:      start,
          duration_minutes: kind === 'planned' ? p!.duration_minutes : mins(slot!.end_time) - mins(slot!.start_time),
          batch_id:        src.batch_id,
          batch_name:      batch?.name      ?? '—',
          batch_owner_id:  batch?.batch_owner_id ?? null,
          centre_name:     centre?.name     ?? '—',
          subject_id:      src.subject_id,
          subject_name:    subj?.name       ?? '—',
          faculty_id:      kind === 'planned' ? p!.faculty_id : (slot?.faculty_id ?? p?.faculty_id ?? null),
          faculty_name:    fac?.full_name   ?? '—',
          classroom_id:    slot?.classroom_id ?? p?.classroom_id ?? null,
          link_id:         p?.link_id ?? null,
          chapter:         kind === 'planned' ? p!.chapter : null,
          topic_name:      kind === 'planned' ? p!.topic_name : null,
          audit_id:        a?.id            ?? null,
          lecture_link:    a?.lecture_link  ?? '',
          topic_check:     a?.topic_check   ?? false,
          duration_check:  a?.duration_check ?? false,
          ppt_check:       a?.ppt_check      ?? false,
          remarks:         a?.remarks        ?? '',
          audit_status:    (a?.audit_status as Lecture['audit_status']) ?? 'pending',
        }
      }).sort((x, y) => (x.start_time ?? '').localeCompare(y.start_time ?? '') || x.batch_name.localeCompare(y.batch_name))

      setLectures(merged)

      // Init edit state
      const initEdits: typeof edits = {}
      merged.forEach(l => {
        initEdits[l.key] = {
          lecture_link:   l.lecture_link,
          topic_check:    l.topic_check,
          duration_check: l.duration_check,
          ppt_check:      l.ppt_check,
          remarks:        l.remarks,
          chapter:        '',
          topic:          '',
        }
      })
      setEdits(initEdits)
    }

    // ── Carry-forward pending: count unaudited lectures from 19 Aug up to (but not including) selected date
    const START_DATE = '2026-08-19' // audit start date

    // Only show earlier pending when viewing a date after the start date
    if (date > START_DATE) {
      const pastQuery = (from: number, to: number, chunk?: string[]) => {
        let q = supabase
          .from('batch_planners')
          .select('id')
          .eq('is_buffer', false)
          .neq('status', 'cancelled')
          .gte('planned_date', START_DATE)   // from audit start
          .lt('planned_date', date)          // up to (not including) selected date
        if (chunk) q = q.in('batch_id', chunk)
        return q.order('id').range(from, to)
      }
      const { data: pastPlanners } = scoped
        ? await fetchAllIn<{ id: string }>(scoped, (chunk, from, to) => pastQuery(from, to, chunk))
        : await fetchAll<{ id: string }>((from, to) => pastQuery(from, to))
      if (pastPlanners.length > 0) {
        const pastIds = pastPlanners.map((p) => p.id)
        const { data: pastAudits } = await fetchAllIn<{ batch_planner_id: string; audit_status: string }>(pastIds, (chunk, from, to) => supabase
          .from('lecture_audits')
          .select('batch_planner_id, audit_status')
          .in('batch_planner_id', chunk).order('batch_planner_id').range(from, to))
        // A lecture is "done" if it's audited or flagged — only truly pending ones carry forward
        const donePastIds = new Set(
          pastAudits
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

  // Planned lectures first; buffer classes (scheduled, no topic planned) after.
  const filtered = useMemo(() => {
    const list = lectures.filter(l => !filterStatus || l.audit_status === filterStatus)
    return [...list.filter(l => l.kind === 'planned'), ...list.filter(l => l.kind !== 'planned')]
  }, [lectures, filterStatus])
  const firstBufferKey = filtered.find(l => l.kind !== 'planned')?.key
  const bufferCount = filtered.filter(l => l.kind !== 'planned').length

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
    const key = lecture.key
    setSaving(key)
    setMessage(null)

    const e = edits[key]
    if (!e) { setSaving(''); return }

    // A class that isn't in the planner becomes a real planner lecture once
    // it's audited as taught: the buffer slot it used is consumed, or a new
    // row is created for the weekly slot. Pacing then counts it.
    let pid = lecture.planner_id
    const taughtChapter = e.chapter.trim(), taughtTopic = e.topic.trim()
    if (lecture.kind !== 'planned') {
      if (e.topic_check && (!taughtChapter || !taughtTopic)) {
        setMessage({ type: 'error', text: 'This is a buffer class — enter the chapter and topic that were taught (or tap “Revision / Doubt”) before ticking Topic ✓.' })
        setSaving(''); return
      }
      const fields = {
        is_buffer: false,
        chapter: taughtChapter || 'Buffer class',
        topic_name: taughtTopic || 'Buffer class',
        start_time: lecture.start_time,
        duration_minutes: lecture.duration_minutes ?? 60,
        classroom_id: lecture.classroom_id,
        status: e.topic_check ? 'conducted' : 'planned',
        stage: 'Confirmed',
      }
      if (lecture.kind === 'buffer' && pid) {
        const { error } = await supabase.from('batch_planners')
          .update({ ...fields, ...(lecture.faculty_id ? { faculty_id: lecture.faculty_id } : {}) }).eq('id', pid)
        if (error) { setMessage({ type: 'error', text: 'Save failed: ' + error.message }); setSaving(''); return }
      } else {
        if (!lecture.faculty_id) {
          setMessage({ type: 'error', text: 'This weekly class has no faculty assigned in the Batch Scheduler — assign one there first.' })
          setSaving(''); return
        }
        // Attach to the batch's planner link when it has one.
        let linkId = lecture.link_id
        if (!linkId) {
          const { data: link } = await supabase.from('batch_planner_links').select('id').eq('batch_id', lecture.batch_id).limit(1).maybeSingle<{ id: string }>()
          linkId = link?.id ?? null
        }
        const { data: ins, error } = await supabase.from('batch_planners').insert({
          ...fields, batch_id: lecture.batch_id, link_id: linkId, subject_id: lecture.subject_id,
          faculty_id: lecture.faculty_id, planned_date: lecture.planned_date,
        }).select('id').single<{ id: string }>()
        if (error || !ins) { setMessage({ type: 'error', text: 'Save failed: ' + (error?.message ?? 'could not create the lecture') }); setSaving(''); return }
        pid = ins.id
      }
    }
    if (!pid) { setSaving(''); return }

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
      // If topic_check is ticked → mark the lecture as conducted in batch_planners.
      // This creates a permanent record: audit done + topic verified = class conducted.
      if (e.topic_check) {
        await supabase
          .from('batch_planners')
          .update({
            status: 'conducted',
            stage: 'Confirmed',
          })
          .eq('id', pid)
          .neq('status', 'conducted') // don't overwrite already-conducted rows
      }

      setMessage({
        type: 'success',
        text: audit_status === 'audited'
          ? '✅ Audited! Lecture marked as conducted in planner.'
          : audit_status === 'flagged' ? '🚩 Flagged.'
          : '⏳ Saved.',
      })
      // Update local state (a not-in-planner class is now a real lecture)
      const nowPlanned = lecture.kind !== 'planned'
        ? { kind: 'planned' as const, planner_id: pid, key: pid, chapter: taughtChapter || 'Buffer class', topic_name: taughtTopic || 'Buffer class' }
        : {}
      setLectures(prev => prev.map(l =>
        l.key !== key ? l : { ...l, audit_status, ...e, ...nowPlanned }
      ))
      if (nowPlanned.key) setEdits(prev => { const { [key]: cur, ...rest } = prev; return { ...rest, [pid!]: { ...cur, chapter: '', topic: '' } } })
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
                const e   = edits[lecture.key] ?? { lecture_link: '', topic_check: false, duration_check: false, ppt_check: false, remarks: '', chapter: '', topic: '' }
                const all = e.topic_check && e.duration_check && e.ppt_check
                const any = e.topic_check || e.duration_check || e.ppt_check
                const hasContent = e.lecture_link.trim() || e.remarks.trim()
                const rowBg =
                  lecture.audit_status === 'audited' ? 'bg-emerald-50/40' :
                  lecture.audit_status === 'flagged' ? 'bg-red-50/40' : ''

                return (
                  <Fragment key={lecture.key}>
                  {lecture.key === firstBufferKey && (
                    <tr>
                      <td colSpan={13} className="px-3 py-2.5 bg-sky-50/70 border-y border-sky-100 text-xs text-sky-900">
                        <b>Buffer classes · {bufferCount}</b> — the batch has a class at this time as per its schedule, but the planner kept it free (a buffer day for revision, doubts or catch-up). Note what was taught, or tap <b>Revision / Doubt</b>, then audit as usual.
                      </td>
                    </tr>
                  )}
                  <tr className={rowBg + ' hover:bg-neutral-50/60'}>
                    <td className={tdCls + ' whitespace-nowrap font-medium'}>
                      {fmt(lecture.start_time)}
                      {lecture.duration_minutes && <span className="text-neutral-400 text-xs ml-1">({lecture.duration_minutes}m)</span>}
                    </td>
                    <td className={tdCls + ' whitespace-nowrap font-medium'}>{lecture.batch_name}</td>
                    <td className={tdCls + ' whitespace-nowrap text-neutral-500'}>{lecture.centre_name}</td>
                    <td className={tdCls + ' whitespace-nowrap'}>{lecture.subject_name}</td>
                    <td className={tdCls + ' whitespace-nowrap text-neutral-600'}>{lecture.faculty_name}</td>
                    <td className={tdCls + ' min-w-[200px]'}>
                      {lecture.kind === 'planned' ? (
                        <>
                          {lecture.chapter && <div className="text-xs text-neutral-500">{lecture.chapter}</div>}
                          <div className="font-medium">{lecture.topic_name || <span className="text-neutral-300 italic">Not set</span>}</div>
                        </>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="inline-block px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-sky-100 text-sky-800 border border-sky-200"
                              title="Scheduled class with no topic planned (buffer day)">
                              Buffer class
                            </span>
                            <button type="button"
                              onClick={() => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], chapter: 'Revision', topic: 'Revision / doubt class' } }))}
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-neutral-200 text-neutral-600 hover:bg-neutral-50">
                              Revision / Doubt
                            </button>
                          </div>
                          <input type="text" value={e.chapter} placeholder="Chapter taught"
                            onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], chapter: ev.target.value } }))}
                            className={inputCls} />
                          <input type="text" value={e.topic} placeholder="Topic taught"
                            onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], topic: ev.target.value } }))}
                            className={inputCls} />
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <input type="url" value={e.lecture_link}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], lecture_link: ev.target.value } }))}
                        placeholder="https://youtube.com/…" className={inputCls} />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.topic_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], topic_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.duration_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], duration_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <input type="checkbox" checked={e.ppt_check}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], ppt_check: ev.target.checked } }))}
                        className="w-4 h-4 rounded border-neutral-300 text-violet-600" />
                    </td>
                    <td className={tdCls}>
                      <input type="text" value={e.remarks}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.key]: { ...prev[lecture.key], remarks: ev.target.value } }))}
                        placeholder="Notes…" className={inputCls} />
                    </td>
                    <td className={tdCls + ' text-center'}>{statusBadge(lecture.audit_status)}</td>
                    <td className={tdCls + ' text-center'}>
                      <button onClick={() => save(lecture)} disabled={saving === lecture.key}
                        className={`px-3 py-1 text-xs font-semibold rounded-lg text-white disabled:opacity-50 ${
                          all ? 'bg-emerald-600 hover:bg-emerald-700' :
                          (any || hasContent) ? 'bg-red-500 hover:bg-red-600' :
                          'bg-violet-600 hover:bg-violet-700'
                        }`}>
                        {saving === lecture.key ? '…' : all ? '✅ Save' : (any || hasContent) ? '🚩 Save' : 'Save'}
                      </button>
                    </td>
                  </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
