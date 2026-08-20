'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

// ─── Types ───────────────────────────────────────────────────────────────────

type Owner = { id: string; full_name: string }

type AuditRow = {
  planner_id: string
  planned_date: string
  batch_name: string
  centre_name: string
  subject_name: string
  faculty_name: string
  chapter: string | null
  topic_name: string | null
  start_time: string | null
  duration_minutes: number | null
  owner_id: string | null
  owner_name: string | null
  // audit fields
  audit_id: string | null
  lecture_link: string | null
  topic_check: boolean
  duration_check: boolean
  ppt_check: boolean
  remarks: string | null
  audit_status: 'pending' | 'audited' | 'flagged'
  audited_by_name: string | null
  audited_at: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function one<T>(v: T | T[] | null): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

const AUDIT_START = '2026-08-19'

const fmt = (t: string | null) => t ? t.slice(0, 5) : '—'
const fmtDate = (d: string) =>
  new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const fmtDateTime = (d: string | null) => d
  ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—'

function statusBadge(s: AuditRow['audit_status']) {
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

// ─── CSV export ───────────────────────────────────────────────────────────────

function toCSV(rows: AuditRow[]): string {
  const headers = [
    'Date', 'Time', 'Batch', 'Centre', 'Subject', 'Faculty',
    'Chapter', 'Topic', 'Batch Owner',
    'Lecture Link', 'Topic Check', 'Duration Check', 'PPT Check',
    'Remarks', 'Audit Status', 'Audited By', 'Audited At',
  ]
  const escape = (v: string | null | boolean | number) => {
    if (v === null || v === undefined) return ''
    const str = String(v)
    if (str.includes(',') || str.includes('"') || str.includes('\n'))
      return `"${str.replace(/"/g, '""')}"`
    return str
  }
  const lines = [
    headers.join(','),
    ...rows.map(r => [
      r.planned_date, fmt(r.start_time), r.batch_name, r.centre_name,
      r.subject_name, r.faculty_name, r.chapter ?? '', r.topic_name ?? '',
      r.owner_name ?? 'Unassigned',
      r.lecture_link ?? '', r.topic_check ? 'Yes' : 'No',
      r.duration_check ? 'Yes' : 'No', r.ppt_check ? 'Yes' : 'No',
      r.remarks ?? '', r.audit_status,
      r.audited_by_name ?? '', r.audited_at ? fmtDateTime(r.audited_at) : '',
    ].map(escape).join(',')),
  ]
  return lines.join('\n')
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AuditReportPage() {
  const supabase = createClient()

  const [rows,    setRows]    = useState<AuditRow[]>([])
  const [owners,  setOwners]  = useState<Owner[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'error'; text: string } | null>(null)

  // Filters
  const [filterOwner,  setFilterOwner]  = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterFrom,   setFilterFrom]   = useState(AUDIT_START)
  const [filterTo,     setFilterTo]     = useState(new Date().toISOString().split('T')[0])
  const [view,         setView]         = useState<'summary' | 'detail'>('summary')

  // ─── Load ─────────────────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true)
    setMessage(null)

    // Central team members (potential batch owners)
    const { data: ct } = await supabase.rpc('get_central_team_members')
    setOwners((ct ?? []) as Owner[])

    // Fetch all batch_planners in date range with batch owner info
    const { data: planners, error } = await supabase
      .from('batch_planners')
      .select(`
        id, planned_date, start_time, duration_minutes, chapter, topic_name,
        batches(id, name, batch_owner_id, centres(name),
          app_users!batches_batch_owner_id_fkey(id, full_name)),
        subjects(name),
        app_users!batch_planners_faculty_id_fkey(full_name),
        lecture_audits(id, lecture_link, topic_check, duration_check, ppt_check,
          remarks, audit_status, audited_at,
          app_users!lecture_audits_audited_by_fkey(full_name))
      `)
      .eq('is_buffer', false)
      .neq('status', 'cancelled')
      .gte('planned_date', filterFrom)
      .lte('planned_date', filterTo)
      .order('planned_date', { ascending: true })
      .order('start_time',   { ascending: true })

    if (error) { setMessage({ type: 'error', text: error.message }); setLoading(false); return }

    const merged: AuditRow[] = (planners ?? []).map(p => {
      const batch   = one(p.batches  as never) as { id: string; name: string; batch_owner_id: string | null; centres: unknown; app_users: unknown } | null
      const centre  = one(batch?.centres as never) as { name: string } | null
      const owner   = one(batch?.app_users as never) as { id: string; full_name: string } | null
      const subj    = one(p.subjects  as never) as { name: string } | null
      const fac     = one(p.app_users as never) as { full_name: string } | null
      const audit   = one(p.lecture_audits as never) as {
        id: string; lecture_link: string | null; topic_check: boolean;
        duration_check: boolean; ppt_check: boolean; remarks: string | null;
        audit_status: string; audited_at: string | null; app_users: unknown
      } | null
      const auditor = one(audit?.app_users as never) as { full_name: string } | null

      return {
        planner_id:       p.id,
        planned_date:     p.planned_date,
        batch_name:       batch?.name      ?? '—',
        centre_name:      centre?.name     ?? '—',
        subject_name:     subj?.name       ?? '—',
        faculty_name:     fac?.full_name   ?? '—',
        chapter:          p.chapter,
        topic_name:       p.topic_name,
        start_time:       p.start_time,
        duration_minutes: p.duration_minutes,
        owner_id:         batch?.batch_owner_id ?? null,
        owner_name:       owner?.full_name  ?? null,
        audit_id:         audit?.id         ?? null,
        lecture_link:     audit?.lecture_link ?? null,
        topic_check:      audit?.topic_check   ?? false,
        duration_check:   audit?.duration_check ?? false,
        ppt_check:        audit?.ppt_check      ?? false,
        remarks:          audit?.remarks         ?? null,
        audit_status:     (audit?.audit_status as AuditRow['audit_status']) ?? 'pending',
        audited_by_name:  auditor?.full_name ?? null,
        audited_at:       audit?.audited_at  ?? null,
      }
    })

    setRows(merged)
    setLoading(false)
  }

  useEffect(() => { load() }, [filterFrom, filterTo])

  // ─── Filtered ─────────────────────────────────────────────────────────────

  const filtered = useMemo(() => rows.filter(r => {
    if (filterOwner  && r.owner_id     !== filterOwner)  return false
    if (filterStatus && r.audit_status !== filterStatus) return false
    return true
  }), [rows, filterOwner, filterStatus])

  // ─── Summary: owner × date grid ───────────────────────────────────────────

  type OwnerDay = {
    owner_id: string | null
    owner_name: string
    total:   number
    audited: number
    flagged: number
    pending: number
    pct:     number
    byDate:  Map<string, { total: number; done: number }>
  }

  const summary = useMemo((): OwnerDay[] => {
    const map = new Map<string, OwnerDay>()

    filtered.forEach(r => {
      const key  = r.owner_id ?? '__unassigned__'
      const name = r.owner_name ?? 'Unassigned'
      if (!map.has(key)) map.set(key, { owner_id: r.owner_id, owner_name: name, total: 0, audited: 0, flagged: 0, pending: 0, pct: 0, byDate: new Map() })
      const od = map.get(key)!
      od.total++
      if (r.audit_status === 'audited') od.audited++
      else if (r.audit_status === 'flagged') od.flagged++
      else od.pending++

      const dayKey = r.planned_date
      const day = od.byDate.get(dayKey) ?? { total: 0, done: 0 }
      day.total++
      if (r.audit_status !== 'pending') day.done++
      od.byDate.set(dayKey, day)
    })

    return Array.from(map.values()).map(od => ({
      ...od,
      pct: od.total > 0 ? Math.round(((od.audited + od.flagged) / od.total) * 100) : 0,
    })).sort((a, b) => b.total - a.total)
  }, [filtered])

  // All distinct dates in filtered data (for summary table header)
  const allDates = useMemo(() => {
    const s = new Set(filtered.map(r => r.planned_date))
    return Array.from(s).sort()
  }, [filtered])

  // ─── Styles ───────────────────────────────────────────────────────────────

  const thCls = 'px-3 py-2 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap border-b border-neutral-200 bg-neutral-50'
  const tdCls = 'px-3 py-2 text-sm text-neutral-800 border-b border-neutral-100 align-top whitespace-nowrap'

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit Report"
        description="Batch owner-wise audit summary and detailed lecture-level report with CSV export."
      />

      {message && <Alert type="error">{message.text}</Alert>}

      {/* ── Controls ── */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">From</label>
            <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">To</label>
            <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Batch Owner</label>
            <select value={filterOwner} onChange={e => setFilterOwner(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 min-w-[160px]">
              <option value="">All owners</option>
              <option value="__unassigned__">Unassigned</option>
              {owners.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Status</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400">
              <option value="">All</option>
              <option value="pending">⏳ Pending</option>
              <option value="audited">✅ Audited</option>
              <option value="flagged">🚩 Flagged</option>
            </select>
          </div>
          <BtnSecondary onClick={() => { setFilterOwner(''); setFilterStatus('') }}>Clear</BtnSecondary>
          <BtnPrimary onClick={load} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </BtnPrimary>
        </div>
      </Card>

      {/* ── View toggle + Stats ── */}
      {!loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total lectures', value: filtered.length,                                           color: 'text-neutral-700' },
              { label: 'Pending',        value: filtered.filter(r => r.audit_status === 'pending').length,  color: 'text-amber-600'   },
              { label: 'Audited',        value: filtered.filter(r => r.audit_status === 'audited').length,  color: 'text-emerald-600' },
              { label: 'Flagged',        value: filtered.filter(r => r.audit_status === 'flagged').length,  color: 'text-red-600'     },
            ].map(s => (
              <Card key={s.label} className="p-4 text-center">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-neutral-500 mt-1">{s.label}</div>
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <button onClick={() => setView('summary')}
                className={`px-4 py-2 text-sm font-semibold rounded-lg border transition-colors ${view === 'summary' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'}`}>
                📊 Summary
              </button>
              <button onClick={() => setView('detail')}
                className={`px-4 py-2 text-sm font-semibold rounded-lg border transition-colors ${view === 'detail' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'}`}>
                📋 Detail
              </button>
            </div>
            <BtnPrimary onClick={() => downloadCSV(toCSV(filtered), `audit-report-${filterFrom}-to-${filterTo}.csv`)}>
              ⬇ Download CSV
            </BtnPrimary>
          </div>
        </>
      )}

      {loading && <Card className="p-10 text-center text-neutral-400">Loading report…</Card>}

      {/* ── Summary View ── */}
      {!loading && view === 'summary' && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className={thCls}>Batch Owner</th>
                <th className={thCls + ' text-center'}>Total</th>
                <th className={thCls + ' text-center'}>Audited</th>
                <th className={thCls + ' text-center'}>Flagged</th>
                <th className={thCls + ' text-center'}>Pending</th>
                <th className={thCls + ' text-center'}>Done %</th>
                {allDates.slice(0, 14).map(d => (
                  <th key={d} className={thCls + ' text-center min-w-[90px]'}>
                    {new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 ? (
                <tr><td colSpan={6 + allDates.length} className={tdCls + ' text-center text-neutral-400 py-8'}>No data for selected filters.</td></tr>
              ) : summary.map(od => (
                <tr key={od.owner_id ?? '__unassigned__'} className="hover:bg-neutral-50">
                  <td className={tdCls + ' font-semibold'}>
                    {od.owner_name}
                    {!od.owner_id && <span className="ml-1 text-xs text-neutral-400">(no owner)</span>}
                  </td>
                  <td className={tdCls + ' text-center font-bold'}>{od.total}</td>
                  <td className={tdCls + ' text-center text-emerald-700 font-semibold'}>{od.audited}</td>
                  <td className={tdCls + ' text-center text-red-700 font-semibold'}>{od.flagged}</td>
                  <td className={tdCls + ' text-center text-amber-700 font-semibold'}>{od.pending}</td>
                  <td className={tdCls + ' text-center'}>
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-16 bg-neutral-200 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full ${od.pct === 100 ? 'bg-emerald-500' : od.pct >= 60 ? 'bg-blue-500' : 'bg-amber-500'}`}
                          style={{ width: `${od.pct}%` }} />
                      </div>
                      <span className="text-xs font-semibold">{od.pct}%</span>
                    </div>
                  </td>
                  {allDates.slice(0, 14).map(d => {
                    const day = od.byDate.get(d)
                    if (!day) return <td key={d} className={tdCls + ' text-center text-neutral-300'}>—</td>
                    const pct = day.total > 0 ? Math.round((day.done / day.total) * 100) : 0
                    const bg = pct === 100 ? 'bg-emerald-100 text-emerald-800' : pct > 0 ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
                    return (
                      <td key={d} className={tdCls + ' text-center'}>
                        <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${bg}`}>
                          {day.done}/{day.total}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {allDates.length > 14 && (
            <p className="text-xs text-neutral-400 p-3 text-center">Showing first 14 dates. Download CSV for full data.</p>
          )}
        </Card>
      )}

      {/* ── Detail View ── */}
      {!loading && view === 'detail' && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left min-w-[1400px]">
            <thead>
              <tr>
                <th className={thCls}>Date</th>
                <th className={thCls}>Time</th>
                <th className={thCls}>Batch</th>
                <th className={thCls}>Centre</th>
                <th className={thCls}>Subject</th>
                <th className={thCls}>Faculty</th>
                <th className={thCls}>Chapter · Topic</th>
                <th className={thCls}>Owner</th>
                <th className={thCls}>Lecture Link</th>
                <th className={thCls + ' text-center'}>Topic</th>
                <th className={thCls + ' text-center'}>Duration</th>
                <th className={thCls + ' text-center'}>PPT</th>
                <th className={thCls}>Remarks</th>
                <th className={thCls + ' text-center'}>Status</th>
                <th className={thCls}>Audited By</th>
                <th className={thCls}>Audited At</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={16} className={tdCls + ' text-center text-neutral-400 py-8'}>No data for selected filters.</td></tr>
              ) : filtered.map(r => (
                <tr key={r.planner_id} className={`hover:bg-neutral-50 ${r.audit_status === 'audited' ? 'bg-emerald-50/30' : r.audit_status === 'flagged' ? 'bg-red-50/30' : ''}`}>
                  <td className={tdCls}>{fmtDate(r.planned_date)}</td>
                  <td className={tdCls}>
                    {fmt(r.start_time)}
                    {r.duration_minutes && <span className="text-neutral-400 text-xs ml-1">({r.duration_minutes}m)</span>}
                  </td>
                  <td className={tdCls + ' font-medium'}>{r.batch_name}</td>
                  <td className={tdCls + ' text-neutral-500'}>{r.centre_name}</td>
                  <td className={tdCls}>{r.subject_name}</td>
                  <td className={tdCls + ' text-neutral-600'}>{r.faculty_name}</td>
                  <td className={tdCls + ' max-w-[200px]'}>
                    {r.chapter && <div className="text-xs text-neutral-500 truncate">{r.chapter}</div>}
                    <div className="font-medium truncate">{r.topic_name || <span className="text-neutral-300 italic">Not set</span>}</div>
                  </td>
                  <td className={tdCls}>
                    {r.owner_name
                      ? <span className="px-2 py-0.5 text-xs font-semibold bg-violet-100 text-violet-800 rounded-full">{r.owner_name}</span>
                      : <span className="text-neutral-400 text-xs">Unassigned</span>}
                  </td>
                  <td className={tdCls + ' max-w-[150px]'}>
                    {r.lecture_link
                      ? <a href={r.lecture_link} target="_blank" rel="noreferrer"
                          className="text-blue-600 hover:underline text-xs truncate block max-w-[140px]">
                          🔗 {r.lecture_link.replace('https://', '').slice(0, 30)}…
                        </a>
                      : <span className="text-neutral-300 text-xs">—</span>}
                  </td>
                  <td className={tdCls + ' text-center'}>{r.topic_check    ? '✅' : '—'}</td>
                  <td className={tdCls + ' text-center'}>{r.duration_check ? '✅' : '—'}</td>
                  <td className={tdCls + ' text-center'}>{r.ppt_check      ? '✅' : '—'}</td>
                  <td className={tdCls + ' max-w-[150px]'}>
                    <span className="text-xs text-neutral-600 line-clamp-2">{r.remarks || '—'}</span>
                  </td>
                  <td className={tdCls + ' text-center'}>{statusBadge(r.audit_status)}</td>
                  <td className={tdCls + ' text-neutral-500'}>{r.audited_by_name || '—'}</td>
                  <td className={tdCls + ' text-neutral-400 text-xs'}>{fmtDateTime(r.audited_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
