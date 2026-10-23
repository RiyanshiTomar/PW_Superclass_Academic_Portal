import { NextResponse } from 'next/server'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { headCaller, istToday, paceStatus, serviceDb } from '@/lib/head'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAY = 86_400_000
const days = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / DAY)

// Batch pace for the Head dashboard: per batch (and per subject) how much of
// the syllabus is done vs. what should be done by today, and whether the rest
// still fits before the batch ends.
export async function GET() {
  if (!(await headCaller())) return NextResponse.json({ error: 'Head or Admin only' }, { status: 403 })
  const db = serviceDb()
  const today = istToday()

  const [bRes, sRes, lRes, subjRes] = await Promise.all([
    db.from('batches').select('id, name, start_date, end_date, status, centre_id, centres(name), programs(name)'),
    fetchAll<{ batch_id: string; effective_to: string | null }>((a, b) => db.from('batch_schedules').select('batch_id, effective_to').order('id').range(a, b)),
    fetchAll<{ batch_id: string; subject_id: string; planned_date: string | null; status: string }>((a, b) =>
      db.from('batch_planners').select('batch_id, subject_id, planned_date, status').eq('is_buffer', false).neq('status', 'cancelled').not('subject_id', 'is', null).order('id').range(a, b)),
    db.from('subjects').select('id, name'),
  ])
  if (bRes.error || lRes.error) return NextResponse.json({ error: bRes.error?.message ?? lRes.error }, { status: 500 })
  const subjName = new Map((subjRes.data ?? []).map((s) => [s.id as string, s.name as string]))

  type B = { id: string; name: string; start_date: string; end_date: string; status: string | null; centre_id: string; centres: { name: string } | { name: string }[] | null; programs: { name: string } | { name: string }[] | null }
  const batches = ((bRes.data ?? []) as unknown as B[]).filter((b) => (b.status ?? '').toLowerCase() !== 'merged')
  const one = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] ?? null : v)

  // Last class day of each batch's weekly schedule (never past the batch end).
  const lastClass = new Map<string, string>()
  const endOf = new Map(batches.map((b) => [b.id, b.end_date]))
  for (const r of sRes.data) {
    const end = endOf.get(r.batch_id)
    if (!end) continue
    const to = r.effective_to && r.effective_to < end ? r.effective_to : end
    if (to > (lastClass.get(r.batch_id) ?? '')) lastClass.set(r.batch_id, to)
  }

  const byBatch = new Map<string, typeof lRes.data>()
  for (const l of lRes.data) byBatch.set(l.batch_id, [...(byBatch.get(l.batch_id) ?? []), l])

  const out = batches.map((b) => {
    const ls = byBatch.get(b.id) ?? []
    const total = ls.length
    const span = Math.max(1, days(b.start_date, b.end_date))
    const frac = Math.min(1, Math.max(0, days(b.start_date, today) / span))
    const fit = lastClass.get(b.id) ?? b.end_date
    const isDone = (l: (typeof ls)[number]) => l.status === 'conducted' || (!!l.planned_date && l.planned_date < today)
    const noSlotOf = (l: (typeof ls)[number]) => !isDone(l) && (!l.planned_date || l.planned_date > fit)
    const done = ls.filter(isDone).length
    const expected = Math.round(frac * total)
    const noSlot = ls.filter(noSlotOf).length
    // Syllabus finish = the last lecture date in the planner.
    const lastOf = (xs: typeof ls) => xs.reduce((a, l) => (l.planned_date && l.planned_date > a ? l.planned_date : a), '') || null
    const finish = lastOf(ls)
    const subjects = new Map<string, { total: number; done: number; noSlot: number; rows: typeof ls }>()
    for (const l of ls) {
      const s = subjects.get(l.subject_id) ?? { total: 0, done: 0, noSlot: 0, rows: [] }
      s.total++; if (isDone(l)) s.done++; if (noSlotOf(l)) s.noSlot++; s.rows.push(l)
      subjects.set(l.subject_id, s)
    }
    const started = b.start_date <= today, ended = b.end_date < today
    return {
      id: b.id, name: b.name, centreId: b.centre_id, centre: one(b.centres)?.name ?? '—', program: one(b.programs)?.name ?? '—',
      start: b.start_date, end: b.end_date, durationDays: span,
      total, done, conducted: ls.filter((l) => l.status === 'conducted').length, expected, noSlot,
      finish, lateDays: finish ? days(b.end_date, finish) : null,
      status: paceStatus({ total, lateDays: finish ? days(b.end_date, finish) : null, durationDays: span, started, ended }),
      subjects: Array.from(subjects.entries()).map(([id, s]) => {
        const f = lastOf(s.rows)
        return { id, name: subjName.get(id) ?? 'Subject', total: s.total, done: s.done, noSlot: s.noSlot, expected: Math.round(frac * s.total), finish: f, lateDays: f ? days(b.end_date, f) : null }
      }).sort((a, b) => (b.lateDays ?? -1e9) - (a.lateDays ?? -1e9)),
    }
  })
  return NextResponse.json({ today, batches: out })
}
