'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllIn } from '@/lib/supabase/fetch-all'
import { getAppUser, getUserCentreIds } from '@/lib/auth'
import { toMinutes, formatTime, weeklySlotActiveOn } from '@/lib/utils'
import { matchClasses } from '@/lib/audit-match'
import { Alert, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Centre = { id: string; name: string; branch_head_id: string | null }
type Classroom = { id: string; name: string; room_no: string | null; centre_id: string; is_active: boolean }
type Kind = 'class' | 'lecture' | 'test' | 'cancelled'
type Block = {
  key: string; roomId: string; startMin: number; endMin: number; kind: Kind
  batch: string; subject: string; topic: string; faculty: string; tag?: string
}

function one<T>(v: T | T[] | null): T | null { return !v ? null : Array.isArray(v) ? v[0] ?? null : v }
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const isoToday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString().split('T')[0] }
const shiftDay = (iso: string, delta: number) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + delta); return d.toISOString().split('T')[0] }

const PALETTE = [
  'bg-violet-100 border-violet-300 text-violet-900',
  'bg-sky-100 border-sky-300 text-sky-900',
  'bg-emerald-100 border-emerald-300 text-emerald-900',
  'bg-amber-100 border-amber-300 text-amber-900',
  'bg-rose-100 border-rose-300 text-rose-900',
  'bg-indigo-100 border-indigo-300 text-indigo-900',
  'bg-teal-100 border-teal-300 text-teal-900',
  'bg-fuchsia-100 border-fuchsia-300 text-fuchsia-900',
]
const PX_PER_MIN = 1

export default function CentreTimetable({ scope = 'central' }: { scope?: 'central' | 'branch' | 'batch-manager' }) {
  const supabase = createClient()
  const [centres, setCentres] = useState<Centre[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [centreId, setCentreId] = useState('')
  const [date, setDate] = useState(isoToday)
  const [loading, setLoading] = useState(true)
  const [loadingDay, setLoadingDay] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const [cRes, clRes] = await Promise.all([
        supabase.from('centres').select('id, name, branch_head_id').order('name'),
        supabase.from('classrooms').select('id, name, room_no, centre_id, is_active').order('room_no'),
      ])
      let centreList = (cRes.data ?? []) as Centre[]
      // Branch head / batch manager only see their own centre(s) — the whole
      // centre, every room, view only.
      if (scope !== 'central') {
        const { data: { user } } = await supabase.auth.getUser()
        const au = user ? await getAppUser(supabase, user) : null
        const ids = new Set(getUserCentreIds(au))
        if (au && scope === 'branch') centreList.filter((c) => c.branch_head_id === au.id).forEach((c) => ids.add(c.id))
        if (au && scope === 'batch-manager') {
          const { data: own } = await supabase.from('batches').select('centre_id').eq('batch_manager_id', au.id)
          for (const b of own ?? []) if (b.centre_id) ids.add(b.centre_id as string)
        }
        centreList = centreList.filter((c) => ids.has(c.id))
      }
      setCentres(centreList)
      if (centreList.length === 1) setCentreId(centreList[0].id)
      if (clRes.data) setClassrooms(clRes.data as Classroom[])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load everything happening at this centre on this date: recurring classes
  // (by weekday) + planner lectures (by date) + tests (by date).
  useEffect(() => {
    if (!centreId) { setBlocks([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingDay(true); setErr(null)
      const weekday = new Date(date + 'T12:00:00').getDay()

      // First get all batch_ids at this centre — PostgREST doesn't reliably
      // filter nested join columns on all versions, so we resolve the centre's
      // batches explicitly and use .in() for safety.
      const { data: centreBatches } = await supabase
        .from('batches')
        .select('id, name')
        .eq('centre_id', centreId)
        .neq('status', 'Merged')
      const batchIds = (centreBatches ?? []).map((b: { id: string }) => b.id)
      const batchNameById = new Map((centreBatches ?? []).map((b: { id: string; name: string }) => [b.id, b.name]))

      if (batchIds.length === 0) {
        if (!cancelled) { setBlocks([]); setLoadingDay(false) }
        return
      }

      const [schedRes, planRes, testRes] = await Promise.all([
        supabase.from('batch_schedules')
          .select('id, start_time, end_time, classroom_id, batch_id, subject_id, faculty_id, effective_from, effective_to, batches(start_date, end_date, status), subjects(name), app_users(full_name)')
          .in('batch_id', batchIds)
          .eq('day_of_week', weekday),
        // Every planner row of the date — buffers and cancel markers too, they
        // decide which class is cancelled / topic-less (lib/audit-match).
        supabase.from('batch_planners')
          .select('id, start_time, duration_minutes, classroom_id, topic_name, batch_id, subject_id, faculty_id, is_buffer, status, subjects(name), app_users!batch_planners_faculty_id_fkey(full_name)')
          .in('batch_id', batchIds)
          .eq('planned_date', date),
        supabase.from('test_schedules')
          .select('id, start_time, duration_minutes, classroom_id, name, test_type, batch_id, subjects(name), app_users!test_schedules_faculty_id_fkey(full_name)')
          .in('batch_id', batchIds)
          .eq('test_date', date)
          .neq('stage', 'Cancelled')
          .not('start_time', 'is', null),
      ])
      if (cancelled) return
      if (schedRes.error) { setErr(schedRes.error.message); setLoadingDay(false); return }

      // Also fetch tests linked via test_batch_mappings (multi-batch tests)
      const { data: mappedTestIds } = await supabase
        .from('test_batch_mappings')
        .select('test_id')
        .in('batch_id', batchIds)
      if (mappedTestIds && mappedTestIds.length > 0) {
        const existingIds = new Set((testRes.data ?? []).map((t: { id: string }) => t.id))
        const newIds = Array.from(new Set(mappedTestIds.map((m: { test_id: string }) => m.test_id))).filter((id) => !existingIds.has(id))
        if (newIds.length > 0) {
          const { data: mappedTests } = await fetchAllIn<NonNullable<typeof testRes.data>[number]>(newIds, (chunk, from, to) => supabase
            .from('test_schedules')
            .select('id, start_time, duration_minutes, classroom_id, name, test_type, batch_id, subjects(name), app_users!test_schedules_faculty_id_fkey(full_name)')
            .in('id', chunk)
            .eq('test_date', date)
            .neq('stage', 'Cancelled')
            .not('start_time', 'is', null)
            .order('id').range(from, to))
          if (mappedTests) (testRes.data as unknown[]) = [...(testRes.data ?? []), ...mappedTests]
        }
      }

      // Each class running today = a weekly slot matched to its planner row by
      // the shared rule (lib/audit-match) — the same set the audit and faculty
      // calendars use. A cancelled class still shows, marked; a substitute's
      // name shows when the lecture's faculty differs from the slot's.
      type SlotRow = { id: string; start_time: string; end_time: string; classroom_id: string | null; batch_id: string; subject_id: string | null; faculty_id: string | null; effective_from: string | null; effective_to: string | null; batches: unknown; subjects: unknown; app_users: unknown }
      type LecRow = { id: string; start_time: string | null; duration_minutes: number; classroom_id: string | null; topic_name: string | null; batch_id: string; subject_id: string | null; faculty_id: string | null; is_buffer: boolean; status: string; subjects: unknown; app_users: unknown }
      const running = ((schedRes.data ?? []) as unknown as SlotRow[]).filter((s) => weeklySlotActiveOn(s, date))
      const out: Block[] = []
      matchClasses(running, (planRes.data ?? []) as unknown as LecRow[], { keepCancelled: true }).forEach(({ kind, p, slot }, i) => {
        const batch = batchNameById.get(slot.batch_id) ?? 'Batch'
        const subject = one(slot.subjects as never)?.['name'] ?? '—'
        const slotFaculty = one(slot.app_users as never)?.['full_name'] ?? '—'
        const lecFaculty = p ? one(p.app_users as never)?.['full_name'] ?? null : null
        const substitute = !!p?.faculty_id && p.faculty_id !== slot.faculty_id && !!lecFaculty
        const startMin = toMinutes(slot.start_time.slice(0, 5)), endMin = toMinutes(slot.end_time.slice(0, 5))
        if (kind === 'cancelled') {
          const why = (p?.topic_name ?? '').startsWith('Class rescheduled') ? p!.topic_name! : 'Class cancelled'
          out.push({ key: `x${i}`, roomId: slot.classroom_id ?? '∅', startMin, endMin, kind: 'cancelled', batch, subject, topic: why, faculty: slotFaculty, tag: why.startsWith('Class rescheduled') ? 'Rescheduled' : 'Cancelled' })
          return
        }
        out.push({
          key: `c${i}`, roomId: slot.classroom_id ?? '∅', startMin, endMin, kind: 'class', batch, subject,
          topic: kind === 'planned' ? (p?.topic_name ?? '') : '',
          faculty: substitute ? `${lecFaculty} (for ${slotFaculty})` : slotFaculty,
          tag: substitute ? 'Substitute' : undefined,
        })
      })
      ;(testRes.data ?? []).forEach((t, i) => {
        const st = toMinutes((t.start_time as string).slice(0, 5))
        const batch = batchNameById.get(t.batch_id as string) ?? 'Batch'
        out.push({ key: `t${i}`, roomId: (t.classroom_id as string) ?? '∅', startMin: st, endMin: st + (t.duration_minutes as number), kind: 'test', batch, subject: (t.name as string) || 'Test', topic: '', faculty: one(t.app_users as never)?.['full_name'] ?? '—', tag: (t.test_type as string) })
      })

      setBlocks(out)
      setLoadingDay(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreId, date])

  const rooms = useMemo(() => classrooms.filter((c) => c.centre_id === centreId && c.is_active), [classrooms, centreId])
  const roomLabel = (c: Classroom) => (c.room_no ? `${c.room_no} · ${c.name}` : c.name)

  const hasUnassigned = blocks.some((b) => b.roomId === '∅')
  const columns = useMemo(() => {
    const cols = rooms.map((r) => ({ id: r.id, label: roomLabel(r) }))
    if (hasUnassigned) cols.push({ id: '∅', label: 'No room set' })
    return cols
  }, [rooms, hasUnassigned])

  const [startHour, endHour] = useMemo(() => {
    let lo = 8 * 60, hi = 20 * 60
    for (const b of blocks) { lo = Math.min(lo, b.startMin); hi = Math.max(hi, b.endMin) }
    return [Math.floor(lo / 60), Math.ceil(hi / 60)]
  }, [blocks])
  const rangeStart = startHour * 60
  const gridHeight = (endHour - startHour) * 60 * PX_PER_MIN
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i)

  const batchColor = useMemo(() => {
    const names = Array.from(new Set(blocks.filter((b) => b.kind !== 'test').map((b) => b.batch))).sort()
    const m = new Map<string, string>()
    names.forEach((n, i) => m.set(n, PALETTE[i % PALETTE.length]))
    return m
  }, [blocks])

  const blockClass = (b: Block) =>
    b.kind === 'test' ? 'bg-neutral-900 border-neutral-900 text-white'
      : b.kind === 'cancelled' ? 'bg-neutral-50 border-dashed border-red-300 text-neutral-400'
      : `${batchColor.get(b.batch) ?? PALETTE[0]} ${b.kind === 'lecture' ? 'border-l-4' : ''}`

  const centreName = centres.find((c) => c.id === centreId)?.name ?? ''
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div>
      <PageHeader title="Calendar" description="Centre-wide day view — every hall on a date: regular classes, planner lectures and tests, all together. Overlaps can't happen, so each hall reads as a clean column." />
      {err && <Alert type="error">{err}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Centre</label>
          <select value={centreId} onChange={(e) => setCentreId(e.target.value)} className="h-11 min-w-[220px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" disabled={loading}>
            <option value="">{loading ? 'Loading…' : 'Select a centre'}</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {centreId && (
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <BtnSecondary onClick={() => setDate((d) => shiftDay(d, -1))}>←</BtnSecondary>
            <BtnSecondary onClick={() => setDate(isoToday())}>Today</BtnSecondary>
            <BtnSecondary onClick={() => setDate((d) => shiftDay(d, 1))}>→</BtnSecondary>
          </div>
        )}
      </div>

      {centreId && (
        <div className="flex flex-wrap gap-3 mb-4 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-violet-200 border border-violet-300 inline-block" /> Class</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-neutral-50 border border-dashed border-red-300 inline-block" /> Cancelled / rescheduled</span>
          <span className="flex items-center gap-1"><span className="px-1 rounded text-[8px] font-bold uppercase bg-amber-200 text-amber-900">Substitute</span> Substitute faculty</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-neutral-900 inline-block" /> Test</span>
        </div>
      )}

      {!centreId ? (
        <Card className="p-10 text-center text-neutral-400">Pick a centre to see its calendar.</Card>
      ) : loadingDay ? (
        <Card className="p-10 text-center text-neutral-400">Loading…</Card>
      ) : rooms.length === 0 ? (
        <Alert type="info">No rooms at {centreName} yet. Add halls in Admin → Centres → Rooms.</Alert>
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-neutral-100 flex items-center justify-between">
            <h3 className="font-semibold text-neutral-950">{centreName} · {dateLabel}</h3>
            <span className="text-xs text-neutral-400">{blocks.filter((b) => b.kind !== 'cancelled').length} event(s){blocks.some((b) => b.kind === 'cancelled') ? ` · ${blocks.filter((b) => b.kind === 'cancelled').length} cancelled` : ''} · {columns.length} hall(s)</span>
          </div>
          {blocks.length === 0 ? (
            <p className="p-8 text-center text-sm text-neutral-400">Nothing scheduled at this centre on this date.</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex min-w-max">
                <div className="shrink-0 w-14 border-r border-neutral-100">
                  <div className="h-9 border-b border-neutral-100" />
                  <div className="relative" style={{ height: gridHeight }}>
                    {hours.map((h) => (
                      <div key={h} className="absolute left-0 right-0 text-[10px] text-neutral-400 pr-1 text-right -translate-y-1/2" style={{ top: (h * 60 - rangeStart) * PX_PER_MIN }}>
                        {formatTime(`${String(h).padStart(2, '0')}:00`)}
                      </div>
                    ))}
                  </div>
                </div>

                {columns.map((col) => {
                  const colBlocks = blocks.filter((b) => b.roomId === col.id)
                  return (
                    <div key={col.id} className="shrink-0 w-44 border-r border-neutral-100 last:border-r-0">
                      <div className="h-9 px-2 flex items-center justify-center text-xs font-semibold text-neutral-700 border-b border-neutral-100 bg-neutral-50 text-center truncate" title={col.label}>{col.label}</div>
                      <div className="relative bg-white" style={{ height: gridHeight }}>
                        {hours.map((h) => (
                          <div key={h} className="absolute left-0 right-0 border-t border-neutral-100" style={{ top: (h * 60 - rangeStart) * PX_PER_MIN }} />
                        ))}
                        {colBlocks.map((b) => {
                          const top = (b.startMin - rangeStart) * PX_PER_MIN
                          const height = Math.max((b.endMin - b.startMin) * PX_PER_MIN, 32)
                          return (
                            <div
                              key={b.key}
                              className={`absolute left-1 right-1 rounded-lg border px-1.5 py-1 overflow-hidden ${blockClass(b)}`}
                              style={{ top, height }}
                              title={`${formatTime(minToHHMM(b.startMin))}–${formatTime(minToHHMM(b.endMin))} · ${b.batch} · ${b.subject}${b.topic ? ` · ${b.topic}` : ''} · ${b.faculty}`}
                            >
                              <div className="flex items-center gap-1 text-[10px] font-bold leading-tight">
                                {formatTime(minToHHMM(b.startMin))}
                                {b.tag && <span className={`px-1 rounded text-[8px] uppercase tracking-wide ${b.kind === 'test' ? 'bg-white/25' : b.kind === 'cancelled' ? 'bg-red-100 text-red-700' : b.tag === 'Substitute' ? 'bg-amber-200 text-amber-900' : 'bg-black/10'}`}>{b.tag}</span>}
                              </div>
                              <div className={`text-[11px] font-semibold leading-tight truncate ${b.kind === 'cancelled' ? 'line-through' : ''}`}>{b.batch}</div>
                              <div className="text-[10px] leading-tight truncate">{b.subject}</div>
                              {b.topic && <div className="text-[10px] leading-tight truncate italic opacity-90">{b.topic}</div>}
                              <div className="text-[10px] leading-tight truncate opacity-80">{b.faculty}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
