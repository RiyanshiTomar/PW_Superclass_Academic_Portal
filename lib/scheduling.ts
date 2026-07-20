import type { SupabaseClient } from '@supabase/supabase-js'
import { timesOverlap, toMinutes } from '@/lib/utils'
import { minutesToTimeString } from '@/lib/validation'

function batchName(value: unknown): string {
  if (Array.isArray(value)) return (value[0] as { name?: string })?.name ?? 'another batch'
  return (value as { name?: string })?.name ?? 'another batch'
}

function batchOf(value: unknown): { name?: string; start_date?: string; end_date?: string } | null {
  if (Array.isArray(value)) return (value[0] as { name?: string; start_date?: string; end_date?: string }) ?? null
  return (value as { name?: string; start_date?: string; end_date?: string }) ?? null
}

/** Two ISO date ranges intersect? NULL bound = open (the whole batch). ISO
 *  strings compare chronologically, so plain string comparison is safe. */
function rangesIntersect(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null): boolean {
  if (aTo && bFrom && aTo < bFrom) return false
  if (bTo && aFrom && bTo < aFrom) return false
  return true
}

/** Recurring weekly batch_schedules overlap. When newFrom/newTo are given, an
 *  existing slot only clashes if its active date-range also intersects the new
 *  slot's — so the same weekday+time in a NON-overlapping date segment is fine. */
export async function checkWeeklyScheduleOverlap(
  supabase: SupabaseClient,
  facultyId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreBatchId?: string,
  newFrom?: string | null,
  newTo?: string | null
): Promise<string | false> {
  let query = supabase
    .from('batch_schedules')
    .select('start_time, end_time, effective_from, effective_to, batches(name, start_date, end_date)')
    .eq('faculty_id', facultyId)
    .eq('day_of_week', dayOfWeek)

  if (ignoreBatchId) query = query.neq('batch_id', ignoreBatchId)

  const { data } = await query
  if (!data?.length) return false

  for (const row of data) {
    if (!timesOverlap(startTime, endTime, row.start_time.slice(0, 5), row.end_time.slice(0, 5))) continue
    const b = batchOf(row.batches)
    const exFrom = (row.effective_from as string | null) ?? b?.start_date ?? null
    const exTo = (row.effective_to as string | null) ?? b?.end_date ?? null
    if ((newFrom || newTo) && !rangesIntersect(newFrom ?? null, newTo ?? null, exFrom, exTo)) continue
    return `Recurring class in batch "${batchName(row.batches)}"`
  }
  return false
}

/** Recurring weekly batch_schedules overlap for a ROOM — one classroom can
 *  only host one class at a time (checked across every batch at the centre).
 *  Date-range aware, like the faculty check above. */
export async function checkClassroomScheduleOverlap(
  supabase: SupabaseClient,
  classroomId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreBatchId?: string,
  newFrom?: string | null,
  newTo?: string | null
): Promise<string | false> {
  let query = supabase
    .from('batch_schedules')
    .select('start_time, end_time, effective_from, effective_to, batches(name, start_date, end_date)')
    .eq('classroom_id', classroomId)
    .eq('day_of_week', dayOfWeek)

  if (ignoreBatchId) query = query.neq('batch_id', ignoreBatchId)

  const { data } = await query
  if (!data?.length) return false

  for (const row of data) {
    if (!timesOverlap(startTime, endTime, row.start_time.slice(0, 5), row.end_time.slice(0, 5))) continue
    const b = batchOf(row.batches)
    const exFrom = (row.effective_from as string | null) ?? b?.start_date ?? null
    const exTo = (row.effective_to as string | null) ?? b?.end_date ?? null
    if ((newFrom || newTo) && !rangesIntersect(newFrom ?? null, newTo ?? null, exFrom, exTo)) continue
    return `Room already hosts batch "${batchName(row.batches)}"`
  }
  return false
}

/** One-off batch_planners on a specific date */
export async function checkPlannerTimeOverlap(
  supabase: SupabaseClient,
  facultyId: string,
  plannedDate: string,
  startTime: string,
  durationMinutes: number,
  ignorePlannerId?: string
): Promise<string | false> {
  const newStart = toMinutes(startTime.slice(0, 5))
  const newEnd = newStart + durationMinutes

  let query = supabase
    .from('batch_planners')
    .select('start_time, duration_minutes, batches(name)')
    .eq('faculty_id', facultyId)
    .eq('planned_date', plannedDate)
    .not('start_time', 'is', null)

  if (ignorePlannerId) query = query.neq('id', ignorePlannerId)

  const { data } = await query
  if (!data?.length) return false

  for (const row of data) {
    const exStart = toMinutes(row.start_time!.slice(0, 5))
    const exEnd = exStart + row.duration_minutes
    if (newStart < exEnd && newEnd > exStart) {
      return `Planned lecture in batch "${batchName(row.batches)}" on same date`
    }
  }
  return false
}

/** Full overlap check when assigning a planner time (weekly + other planners) */
export async function checkFacultyAssignmentOverlap(
  supabase: SupabaseClient,
  facultyId: string,
  plannedDate: string,
  startTime: string,
  durationMinutes: number,
  ignorePlannerId?: string
): Promise<string | false> {
  const date = new Date(plannedDate + 'T12:00:00')
  const dayOfWeek = date.getDay()
  const endTime = minutesToTimeString(toMinutes(startTime.slice(0, 5)) + durationMinutes)

  const weekly = await checkWeeklyScheduleOverlap(
    supabase,
    facultyId,
    dayOfWeek,
    startTime.slice(0, 5),
    endTime,
    undefined,
    plannedDate,
    plannedDate
  )
  if (weekly) return `Overlap with ${weekly}`

  const planner = await checkPlannerTimeOverlap(
    supabase,
    facultyId,
    plannedDate,
    startTime,
    durationMinutes,
    ignorePlannerId
  )
  if (planner) return `Overlap with ${planner}`

  return false
}
