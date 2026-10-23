import { NextResponse } from 'next/server'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { headCaller, istToday, serviceDb } from '@/lib/head'
import { toMinutes, weeklySlotActiveOn, WEEKLY_SLOT_COLS } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAY = /^\d{4}-\d{2}-\d{2}$/

// Faculty usage for the Head dashboard: hours each faculty taught (and has
// planned) in a date range, per batch and subject, plus their weekly hours on
// the current timetable.
export async function GET(request: Request) {
  if (!(await headCaller())) return NextResponse.json({ error: 'Head or Admin only' }, { status: 403 })
  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? ''
  if (!DAY.test(from) || !DAY.test(to) || from > to) return NextResponse.json({ error: 'Pick a valid date range.' }, { status: 400 })
  const db = serviceDb()
  const today = istToday()

  const [fRes, ucRes, cRes, bRes, subjRes, lRes, sRes] = await Promise.all([
    fetchAll<{ id: string; full_name: string; status: string | null; role: string | null; roles: string[] | null }>((a, b) =>
      db.from('app_users').select('id, full_name, status, role, roles').or('role.eq.faculty,roles.cs.{faculty}').order('id').range(a, b)),
    fetchAll<{ user_id: string; centre_id: string }>((a, b) => db.from('user_centres').select('user_id, centre_id').order('user_id').order('centre_id').range(a, b)),
    db.from('centres').select('id, name'),
    db.from('batches').select('id, name, centre_id, status'),
    db.from('subjects').select('id, name'),
    fetchAll<{ batch_id: string; faculty_id: string | null; subject_id: string | null; planned_date: string; duration_minutes: number | null }>((a, b) =>
      db.from('batch_planners').select('batch_id, faculty_id, subject_id, planned_date, duration_minutes').eq('is_buffer', false).neq('status', 'cancelled')
        .gte('planned_date', from).lte('planned_date', to).not('faculty_id', 'is', null).order('id').range(a, b)),
    fetchAll<{ batch_id: string; faculty_id: string | null; subject_id: string | null; start_time: string; end_time: string; effective_from: string | null; effective_to: string | null; batches: unknown }>((a, b) =>
      db.from('batch_schedules').select(`batch_id, faculty_id, subject_id, start_time, end_time, ${WEEKLY_SLOT_COLS}`).order('id').range(a, b)),
  ])
  const err = fRes.error ?? lRes.error ?? sRes.error
  if (err) return NextResponse.json({ error: err }, { status: 500 })

  const batches = (bRes.data ?? []) as { id: string; name: string; centre_id: string; status: string | null }[]
  const centreOfBatch = new Map(batches.map((b) => [b.id, b.centre_id]))

  // Lectures in the range → (faculty, batch, subject) minutes, split into
  // taught (till today) and still to come.
  const key = (f: string, b: string, s: string | null) => `${f}|${b}|${s ?? ''}`
  const agg = new Map<string, { facultyId: string; batchId: string; subjectId: string | null; lectures: number; taughtMin: number; upcomingMin: number; upcomingLectures: number }>()
  for (const l of lRes.data) {
    const k = key(l.faculty_id as string, l.batch_id, l.subject_id)
    const cur = agg.get(k) ?? { facultyId: l.faculty_id as string, batchId: l.batch_id, subjectId: l.subject_id, lectures: 0, taughtMin: 0, upcomingMin: 0, upcomingLectures: 0 }
    const min = l.duration_minutes ?? 0
    if (l.planned_date <= today) { cur.lectures++; cur.taughtMin += min } else { cur.upcomingLectures++; cur.upcomingMin += min }
    agg.set(k, cur)
  }

  // Weekly hours on the timetable running today.
  const weekly = new Map<string, number>() // `${faculty}|${centre}|${subject}` → minutes per week
  for (const s of sRes.data) {
    if (!s.faculty_id || !weeklySlotActiveOn(s, today)) continue
    const c = centreOfBatch.get(s.batch_id)
    if (!c) continue
    const k = `${s.faculty_id}|${c}|${s.subject_id ?? ''}`
    weekly.set(k, (weekly.get(k) ?? 0) + Math.max(0, toMinutes(s.end_time) - toMinutes(s.start_time)))
  }

  const centresOf = new Map<string, string[]>()
  for (const r of ucRes.data) centresOf.set(r.user_id, [...(centresOf.get(r.user_id) ?? []), r.centre_id])

  return NextResponse.json({
    from, to, today,
    centres: cRes.data ?? [],
    subjects: subjRes.data ?? [],
    batches: batches.map((b) => ({ id: b.id, name: b.name, centreId: b.centre_id })),
    faculty: fRes.data.filter((f) => f.status !== 'inactive').map((f) => ({ id: f.id, name: f.full_name, centreIds: centresOf.get(f.id) ?? [] })),
    usage: Array.from(agg.values()).map((u) => ({ ...u, centreId: centreOfBatch.get(u.batchId) ?? null })),
    weekly: Array.from(weekly.entries()).map(([k, min]) => { const [facultyId, centreId, subjectId] = k.split('|'); return { facultyId, centreId, subjectId: subjectId || null, min } }),
  })
}
