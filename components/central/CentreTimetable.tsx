'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toMinutes, formatTime } from '@/lib/utils'
import { Alert, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Centre = { id: string; name: string }
type Classroom = { id: string; name: string; room_no: string | null; centre_id: string; is_active: boolean }
type Kind = 'class' | 'lecture' | 'test'
type Block = {
  key: string; roomId: string; startMin: number; endMin: number; kind: Kind
  batch: string; title: string; faculty: string; tag?: string
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

export default function CentreTimetable() {
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
        supabase.from('centres').select('id, name').order('name'),
        supabase.from('classrooms').select('id, name, room_no, centre_id, is_active').order('room_no'),
      ])
      if (cRes.data) setCentres(cRes.data as Centre[])
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
      const [schedRes, planRes, testRes] = await Promise.all([
        supabase.from('batch_schedules')
          .select('start_time, end_time, classroom_id, batches!inner(name, centre_id), subjects(name), app_users(full_name)')
          .eq('batches.centre_id', centreId).eq('day_of_week', weekday),
        supabase.from('batch_planners')
          .select('start_time, duration_minutes, classroom_id, topic_name, batches!inner(name, centre_id), subjects(name), app_users(full_name)')
          .eq('batches.centre_id', centreId).eq('planned_date', date).not('start_time', 'is', null),
        supabase.from('test_schedules')
          .select('start_time, duration_minutes, classroom_id, name, test_type, batches!inner(name, centre_id), subjects(name), app_users(full_name)')
          .eq('batches.centre_id', centreId).eq('test_date', date),
      ])
      if (cancelled) return
      if (schedRes.error) setErr(schedRes.error.message)

      const out: Block[] = []
      ;(schedRes.data ?? []).forEach((s, i) => {
        const st = toMinutes((s.start_time as string).slice(0, 5))
        out.push({ key: `c${i}`, roomId: (s.classroom_id as string) ?? '∅', startMin: st, endMin: toMinutes((s.end_time as string).slice(0, 5)), kind: 'class', batch: one(s.batches as never)?.['name'] ?? 'Batch', title: one(s.subjects as never)?.['name'] ?? '—', faculty: one(s.app_users as never)?.['full_name'] ?? '—' })
      })
      ;(planRes.data ?? []).forEach((p, i) => {
        const st = toMinutes((p.start_time as string).slice(0, 5))
        out.push({ key: `p${i}`, roomId: (p.classroom_id as string) ?? '∅', startMin: st, endMin: st + (p.duration_minutes as number), kind: 'lecture', batch: one(p.batches as never)?.['name'] ?? 'Batch', title: (p.topic_name as string) || (one(p.subjects as never)?.['name'] ?? 'Lecture'), faculty: one(p.app_users as never)?.['full_name'] ?? '—', tag: 'Planner' })
      })
      ;(testRes.data ?? []).forEach((t, i) => {
        const st = toMinutes((t.start_time as string).slice(0, 5))
        out.push({ key: `t${i}`, roomId: (t.classroom_id as string) ?? '∅', startMin: st, endMin: st + (t.duration_minutes as number), kind: 'test', batch: one(t.batches as never)?.['name'] ?? 'Batch', title: (t.name as string) || 'Test', faculty: one(t.app_users as never)?.['full_name'] ?? '—', tag: (t.test_type as string) })
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
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-violet-200 border-l-4 border-violet-400 inline-block" /> Planner lecture</span>
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
            <span className="text-xs text-neutral-400">{blocks.length} event(s) · {columns.length} hall(s)</span>
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
                            <div key={b.key} className={`absolute left-1 right-1 rounded-lg border px-1.5 py-1 overflow-hidden ${blockClass(b)}`} style={{ top, height }} title={`${formatTime(minToHHMM(b.startMin))}–${formatTime(minToHHMM(b.endMin))} · ${b.batch} · ${b.title} · ${b.faculty}`}>
                              <div className="flex items-center gap-1 text-[10px] font-bold leading-tight">
                                {formatTime(minToHHMM(b.startMin))}
                                {b.tag && <span className={`px-1 rounded text-[8px] uppercase tracking-wide ${b.kind === 'test' ? 'bg-white/25' : 'bg-black/10'}`}>{b.tag}</span>}
                              </div>
                              <div className="text-[11px] font-semibold leading-tight truncate">{b.batch}</div>
                              <div className="text-[10px] leading-tight truncate">{b.title}</div>
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
