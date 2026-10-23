'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all'

type Row = { id: string; name: string; centre: string; lastDay: string; endDate: string; pending: number; noSlot: number; notMarked: number }

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const fmt = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

// Central Hub alert: a batch whose weekly schedule has run out (no class
// after its last date range) while planner lectures are still left. Such a
// batch shows nothing on the calendar, so central must extend the schedule
// (or merge / close the batch).
export default function ScheduleEndedAlert() {
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const today = istToday()
      const [bRes, sRes] = await Promise.all([
        supabase.from('batches').select('id, name, end_date, status, centres(name)'),
        fetchAll<{ batch_id: string; effective_to: string | null }>((a, b) => supabase.from('batch_schedules').select('batch_id, effective_to').order('id').range(a, b)),
      ])
      const batches = ((bRes.data ?? []) as unknown as { id: string; name: string; end_date: string; status: string | null; centres: { name: string } | { name: string }[] | null }[])
        .filter((b) => (b.status ?? '').toLowerCase() !== 'merged')
      // Last class date per batch = latest date range end (open range → batch end), never past the batch end.
      const last = new Map<string, string>()
      const endOf = new Map(batches.map((b) => [b.id, b.end_date]))
      for (const r of sRes.data) {
        const end = endOf.get(r.batch_id)
        if (!end) continue
        const to = r.effective_to && r.effective_to < end ? r.effective_to : end
        if (to > (last.get(r.batch_id) ?? '')) last.set(r.batch_id, to)
      }
      const ended = batches.filter((b) => last.has(b.id) && (last.get(b.id) as string) < today)
      if (!ended.length) { if (!cancelled) setRows([]); return }
      const { data: lectures } = await fetchAllIn<{ batch_id: string; planned_date: string | null }>(ended.map((b) => b.id), (chunk, a, b) =>
        supabase.from('batch_planners').select('batch_id, planned_date').in('batch_id', chunk).eq('is_buffer', false)
          .neq('status', 'cancelled').neq('status', 'conducted').not('subject_id', 'is', null).order('id').range(a, b))
      const out: Row[] = []
      for (const b of ended) {
        const lastDay = last.get(b.id) as string
        const mine = lectures.filter((l) => l.batch_id === b.id)
        if (!mine.length) continue
        const noSlot = mine.filter((l) => !l.planned_date || l.planned_date > lastDay).length
        const c = Array.isArray(b.centres) ? b.centres[0] : b.centres
        out.push({ id: b.id, name: b.name, centre: c?.name ?? '', lastDay, endDate: b.end_date, pending: mine.length, noSlot, notMarked: mine.length - noSlot })
      }
      out.sort((a, b) => b.pending - a.pending)
      if (!cancelled) setRows(out)
    })().catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!rows.length) return null
  const shown = open ? rows : rows.slice(0, 3)
  return (
    <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <b>⚠ Schedule ended but lectures are left — {rows.length} batch{rows.length === 1 ? '' : 'es'}</b>
        <span className="text-xs text-amber-800">These batches show no classes on the calendar after their last date.</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((r) => (
          <li key={r.id} className="rounded-lg bg-white/70 border border-amber-200 px-3 py-2">
            <span className="font-semibold">{r.name}</span>{r.centre && <span className="text-amber-800"> · {r.centre}</span>}
            <span> — last class <b>{fmt(r.lastDay)}</b>{r.endDate > r.lastDay ? <> (batch ends {fmt(r.endDate)})</> : null}, <b>{r.pending} lectures left</b></span>
            <span className="block text-xs text-amber-800 mt-0.5">
              {r.noSlot > 0 && <>{r.noSlot} have no class date left</>}
              {r.noSlot > 0 && r.notMarked > 0 && ' · '}
              {r.notMarked > 0 && <>{r.notMarked} past lectures not marked conducted</>}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 3 && (
        <button onClick={() => setOpen(!open)} className="mt-2 text-xs font-semibold text-amber-900 underline">{open ? 'Show less' : `Show all ${rows.length}`}</button>
      )}
      <p className="mt-2 text-xs text-amber-800">
        Fix: Batch Scheduler → Edit the batch → move the batch <b>End date</b> and each subject&apos;s <b>TO</b> date forward (or add a new date range), then Save — the left lectures get dates automatically.
        If the batch has really finished or was merged, merge / close it instead.
      </p>
    </div>
  )
}
