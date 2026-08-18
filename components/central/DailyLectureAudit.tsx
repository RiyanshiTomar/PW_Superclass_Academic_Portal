'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Lecture = {
  planner_id: string
  batch_id: string
  batch_name: string
  centre_id: string
  centre_name: string
  subject_id: string | null
  subject_name: string | null
  faculty_id: string | null
  faculty_name: string | null
  planned_date: string
  start_time: string | null
  duration_minutes: number | null
  topic_name: string | null
  chapter: string | null
  status: string
  // audit fields (from lecture_audits table)
  audit_id: string | null
  lecture_link: string
  topic_check: boolean
  duration_check: boolean
  ppt_check: boolean
  remarks: string
  audit_status: 'pending' | 'audited' | 'flagged'
  audited_by_name: string | null
  audited_at: string | null
}

type Centre = { id: string; name: string }
type Batch  = { id: string; name: string; centre_id: string }

export default function DailyLectureAudit() {
  const supabase = createClient()

  const [lectures, setLectures]   = useState<Lecture[]>([])
  const [centres,  setCentres]    = useState<Centre[]>([])
  const [batches,  setBatches]    = useState<Batch[]>([])
  const [loading,  setLoading]    = useState(true)
  const [saving,   setSaving]     = useState<string>('')
  const [message,  setMessage]    = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // filters
  const [filterDate,    setFilterDate]    = useState(new Date().toISOString().split('T')[0])
  const [filterCentre,  setFilterCentre]  = useState('')
  const [filterBatch,   setFilterBatch]   = useState('')
  const [filterStatus,  setFilterStatus]  = useState('')

  // inline edit state — keyed by planner_id
  const [edits, setEdits] = useState<Record<string, {
    lecture_link: string
    topic_check: boolean
    duration_check: boolean
    ppt_check: boolean
    remarks: string
  }>>({})

  // ─── load ───────────────────────────────────────────────────────────────────
  const load = async (date: string) => {
    setLoading(true)
    setMessage(null)

    try {
      // 1. centres + batches for filter dropdowns
      const [centresRes, batchesRes] = await Promise.all([
        supabase.from('centres').select('id, name').order('name'),
        supabase.from('batches').select('id, name, centre_id').order('name'),
      ])
      if (centresRes.data) setCentres(centresRes.data)
      if (batchesRes.data) setBatches(batchesRes.data)

      // 2. scheduled lectures from today onwards (30-day window)
      const end = new Date(new Date(date).getTime() + 30 * 86400_000).toISOString().split('T')[0]

      const { data: planners, error: pErr } = await supabase
        .from('batch_planners')
        .select(`
          id,
          batch_id,
          subject_id,
          faculty_id,
          planned_date,
          start_time,
          duration_minutes,
          topic_name,
          chapter,
          status,
          batches(id, name, centre_id, centres(id, name)),
          subjects(id, name),
          app_users!batch_planners_faculty_id_fkey(id, full_name)
        `)
        .eq('is_buffer', false)
        .gte('planned_date', date)
        .lte('planned_date', end)
        .neq('status', 'cancelled')
        .order('planned_date', { ascending: true })
        .order('start_time',   { ascending: true })

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

      // 3. existing audit rows for these planners
      const ids = planners.map(p => p.id)
      const { data: audits } = await supabase
        .from('lecture_audits')
        .select(`
          id,
          batch_planner_id,
          lecture_link,
          topic_check,
          duration_check,
          ppt_check,
          remarks,
          audit_status,
          audited_at,
          app_users!lecture_audits_audited_by_fkey(full_name)
        `)
        .in('batch_planner_id', ids)

      const auditMap = new Map<string, typeof audits extends (infer T)[] | null ? T : never>()
      for (const a of (audits ?? [])) auditMap.set(a.batch_planner_id, a)

      // 4. merge
      const merged: Lecture[] = planners.map(p => {
        const a    = auditMap.get(p.id)
        const batch  = Array.isArray(p.batches)  ? p.batches[0]  : p.batches
        const centre = Array.isArray(batch?.centres) ? batch.centres[0] : batch?.centres
        const subj   = Array.isArray(p.subjects) ? p.subjects[0] : p.subjects
        const fac    = Array.isArray(p.app_users) ? p.app_users[0] : p.app_users

        return {
          planner_id:      p.id,
          batch_id:        p.batch_id,
          batch_name:      batch?.name      ?? '—',
          centre_id:       batch?.centre_id ?? '',
          centre_name:     centre?.name     ?? '—',
          subject_id:      p.subject_id,
          subject_name:    subj?.name       ?? '—',
          faculty_id:      p.faculty_id,
          faculty_name:    fac?.full_name   ?? '—',
          planned_date:    p.planned_date,
          start_time:      p.start_time,
          duration_minutes: p.duration_minutes,
          topic_name:      p.topic_name,
          chapter:         p.chapter,
          status:          p.status,
          // audit
          audit_id:        a?.id            ?? null,
          lecture_link:    a?.lecture_link  ?? '',
          topic_check:     a?.topic_check   ?? false,
          duration_check:  a?.duration_check ?? false,
          ppt_check:       a?.ppt_check      ?? false,
          remarks:         a?.remarks        ?? '',
          audit_status:    (a?.audit_status as Lecture['audit_status']) ?? 'pending',
          audited_by_name: (Array.isArray(a?.app_users) ? a.app_users[0]?.full_name : (a?.app_users as any)?.full_name) ?? null,
          audited_at:      a?.audited_at    ?? null,
        }
      })

      setLectures(merged)

      // populate edit state from saved audit data
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

    } catch (err: any) {
      setMessage({ type: 'error', text: 'Unexpected error: ' + err.message })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(filterDate) }, [filterDate])

  // ─── filter ─────────────────────────────────────────────────────────────────
  const filteredBatches = useMemo(
    () => batches.filter(b => !filterCentre || b.centre_id === filterCentre),
    [batches, filterCentre]
  )

  const shown = useMemo(() => lectures.filter(l => {
    if (filterCentre && l.centre_id !== filterCentre) return false
    if (filterBatch  && l.batch_id  !== filterBatch)  return false
    if (filterStatus && l.audit_status !== filterStatus) return false
    return true
  }), [lectures, filterCentre, filterBatch, filterStatus])

  // ─── save audit ─────────────────────────────────────────────────────────────
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
    if (allChecked)  audit_status = 'audited'
    else if (anyChecked || hasContent) audit_status = 'flagged'

    // get current user id
    const { data: { user } } = await supabase.auth.getUser()

    const row = {
      batch_planner_id: pid,
      batch_id:         lecture.batch_id,
      centre_id:        lecture.centre_id,
      subject_id:       lecture.subject_id,
      faculty_id:       lecture.faculty_id,
      lecture_date:     lecture.planned_date,
      lecture_link:     e.lecture_link.trim() || null,
      topic_check:      e.topic_check,
      duration_check:   e.duration_check,
      ppt_check:        e.ppt_check,
      remarks:          e.remarks.trim() || null,
      audit_status,
      audited_by:       user?.id ?? null,
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
        text: audit_status === 'audited' ? '✅ Lecture audited!'
            : audit_status === 'flagged' ? '🚩 Lecture flagged.'
            : '⏳ Saved as pending.'
      })
      // refresh just this lecture's status in-place
      setLectures(prev => prev.map(l =>
        l.planner_id !== pid ? l : { ...l, audit_status, ...e }
      ))
    }
    setSaving('')
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────
  const fmt = (t: string | null) => t ? t.slice(0, 5) : '—'
  const fmtDate = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

  const statusBadge = (s: Lecture['audit_status']) => {
    const map = {
      pending: 'bg-amber-100 text-amber-800 border-amber-200',
      audited: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      flagged: 'bg-red-100 text-red-800 border-red-200',
    }
    const icon = { pending: '⏳', audited: '✅', flagged: '🚩' }
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${map[s]}`}>
        {icon[s]} {s.charAt(0).toUpperCase() + s.slice(1)}
      </span>
    )
  }

  // ─── stats (from shown lectures) ─────────────────────────────────────────────
  const stats = useMemo(() => {
    const total   = shown.length
    const audited = shown.filter(l => l.audit_status === 'audited').length
    const flagged = shown.filter(l => l.audit_status === 'flagged').length
    const pending = total - audited - flagged
    return { total, audited, flagged, pending }
  }, [shown])

  // ─── render ──────────────────────────────────────────────────────────────────
  const inputCls = 'w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400'

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Daily Lecture Audit"
        description="Date-wise lecture schedule with quality verification for central team"
      />

      {message && (
        <Alert type={message.type}>{message.text}</Alert>
      )}

      {/* ── Filters ── */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">From Date</label>
            <input
              type="date"
              value={filterDate}
              onChange={e => { setFilterDate(e.target.value); setFilterCentre(''); setFilterBatch(''); setFilterStatus('') }}
              className="h-10 px-3 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
            <select
              value={filterCentre}
              onChange={e => { setFilterCentre(e.target.value); setFilterBatch('') }}
              className="h-10 px-3 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]"
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
              className="h-10 px-3 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]"
            >
              <option value="">All batches</option>
              {filteredBatches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Status</label>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="h-10 px-3 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              <option value="">All</option>
              <option value="pending">⏳ Pending</option>
              <option value="audited">✅ Audited</option>
              <option value="flagged">🚩 Flagged</option>
            </select>
          </div>
          <BtnSecondary onClick={() => { setFilterCentre(''); setFilterBatch(''); setFilterStatus('') }}>
            Clear
          </BtnSecondary>
        </div>
      </Card>

      {/* ── Stats strip ── */}
      {!loading && shown.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Total',   value: stats.total,   color: 'text-neutral-700' },
            { label: 'Audited', value: stats.audited, color: 'text-emerald-600'  },
            { label: 'Flagged', value: stats.flagged, color: 'text-red-600'      },
            { label: 'Pending', value: stats.pending, color: 'text-amber-600'    },
          ].map(s => (
            <Card key={s.label} className="p-4 text-center">
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-neutral-500 mt-1">{s.label}</div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <Card className="p-10 text-center text-neutral-400">Loading lectures…</Card>
      )}

      {/* ── Empty ── */}
      {!loading && shown.length === 0 && (
        <Card className="p-10 text-center text-neutral-400">
          No lectures found for the selected filters.
        </Card>
      )}

      {/* ── Lecture rows ── */}
      {!loading && shown.length > 0 && (
        <div className="space-y-4">
          {shown.map(lecture => {
            const e   = edits[lecture.planner_id] ?? { lecture_link: '', topic_check: false, duration_check: false, ppt_check: false, remarks: '' }
            const all = e.topic_check && e.duration_check && e.ppt_check
            const any = e.topic_check || e.duration_check || e.ppt_check
            const hasContent = e.lecture_link.trim() || e.remarks.trim()

            const cardBorder =
              lecture.audit_status === 'audited' ? 'border-emerald-200' :
              lecture.audit_status === 'flagged' ? 'border-red-200'     : 'border-neutral-200'

            return (
              <Card key={lecture.planner_id} className={`border ${cardBorder}`}>
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-neutral-100">

                  {/* ── LEFT: lecture info ── */}
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-neutral-900">{lecture.batch_name}</p>
                        <p className="text-xs text-neutral-500">{lecture.centre_name}</p>
                      </div>
                      {statusBadge(lecture.audit_status)}
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      <div>
                        <span className="text-neutral-500">📅 Date</span>
                        <p className="font-medium">{fmtDate(lecture.planned_date)}</p>
                      </div>
                      <div>
                        <span className="text-neutral-500">⏰ Time</span>
                        <p className="font-medium">
                          {fmt(lecture.start_time)}
                          {lecture.duration_minutes ? ` · ${lecture.duration_minutes}m` : ''}
                        </p>
                      </div>
                      <div>
                        <span className="text-neutral-500">📚 Subject</span>
                        <p className="font-medium">{lecture.subject_name}</p>
                      </div>
                      <div>
                        <span className="text-neutral-500">👨‍🏫 Faculty</span>
                        <p className="font-medium">{lecture.faculty_name}</p>
                      </div>
                      {lecture.chapter && (
                        <div className="col-span-2">
                          <span className="text-neutral-500">📖 Chapter</span>
                          <p className="font-medium">{lecture.chapter}</p>
                        </div>
                      )}
                      {lecture.topic_name && (
                        <div className="col-span-2">
                          <span className="text-neutral-500">📝 Topic</span>
                          <p className="font-medium">{lecture.topic_name}</p>
                        </div>
                      )}
                    </div>

                    {lecture.audited_by_name && (
                      <p className="text-xs text-neutral-400 pt-2 border-t border-neutral-100">
                        Audited by <span className="font-medium text-neutral-600">{lecture.audited_by_name}</span>
                        {lecture.audited_at && ` on ${new Date(lecture.audited_at).toLocaleDateString('en-GB')}`}
                      </p>
                    )}
                  </div>

                  {/* ── RIGHT: audit form ── */}
                  <div className="p-5 space-y-4">
                    <p className="text-sm font-semibold text-neutral-700">🔍 Audit</p>

                    {/* link */}
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Lecture Link (YouTube / Drive)</label>
                      <input
                        type="url"
                        value={e.lecture_link}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], lecture_link: ev.target.value } }))}
                        placeholder="https://youtube.com/watch?v=…"
                        className={inputCls}
                      />
                    </div>

                    {/* checkboxes */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600">Verification</label>
                      {([
                        { key: 'topic_check',    label: 'Topic covered as planned' },
                        { key: 'duration_check', label: 'Full duration completed'   },
                        { key: 'ppt_check',      label: 'Quality PPT / material used' },
                      ] as const).map(({ key, label }) => (
                        <label key={key} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={e[key]}
                            onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], [key]: ev.target.checked } }))}
                            className="w-4 h-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-400"
                          />
                          <span className="text-sm text-neutral-700">{label}</span>
                        </label>
                      ))}
                    </div>

                    {/* remarks */}
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Remarks</label>
                      <textarea
                        value={e.remarks}
                        onChange={ev => setEdits(prev => ({ ...prev, [lecture.planner_id]: { ...prev[lecture.planner_id], remarks: ev.target.value } }))}
                        placeholder="Observations or feedback…"
                        rows={2}
                        className={inputCls + ' resize-none'}
                      />
                    </div>

                    {/* save button */}
                    <BtnPrimary
                      onClick={() => save(lecture)}
                      disabled={saving === lecture.planner_id}
                      className={`w-full ${
                        all ? 'bg-emerald-600 hover:bg-emerald-700' :
                        (any || hasContent) ? 'bg-red-600 hover:bg-red-700' : ''
                      }`}
                    >
                      {saving === lecture.planner_id ? 'Saving…'
                        : all ? '✅ Save as Audited'
                        : (any || hasContent) ? '🚩 Save as Flagged'
                        : '💾 Save Audit'}
                    </BtnPrimary>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
