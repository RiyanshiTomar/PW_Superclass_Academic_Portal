import type { SupabaseClient } from '@supabase/supabase-js'
import { timesOverlap, toMinutes } from '@/lib/utils'
import { minutesToTimeString } from '@/lib/validation'

function batchName(value: unknown): string {
  if (Array.isArray(value)) return (value[0] as { name?: string })?.name ?? 'another batch'
  return (value as { name?: string })?.name ?? 'another batch'
}

/** Recurring weekly batch_schedules overlap */
export async function checkWeeklyScheduleOverlap(
  supabase: SupabaseClient,
  facultyId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreBatchId?: string
): Promise<string | false> {
  let query = supabase
    .from('batch_schedules')
    .select('start_time, end_time, batches(name)')
    .eq('faculty_id', facultyId)
    .eq('day_of_week', dayOfWeek)

  if (ignoreBatchId) query = query.neq('batch_id', ignoreBatchId)

  const { data } = await query
  if (!data?.length) return false

  for (const row of data) {
    if (
      timesOverlap(
        startTime,
        endTime,
        row.start_time.slice(0, 5),
        row.end_time.slice(0, 5)
      )
    ) {
      return `Recurring class in batch "${batchName(row.batches)}"`
    }
  }
  return false
}

/** Recurring weekly batch_schedules overlap for a ROOM — one classroom can
 *  only host one class at a time (checked across every batch at the centre). */
export async function checkClassroomScheduleOverlap(
  supabase: SupabaseClient,
  classroomId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreBatchId?: string
): Promise<string | false> {
  let query = supabase
    .from('batch_schedules')
    .select('start_time, end_time, batches(name)')
    .eq('classroom_id', classroomId)
    .eq('day_of_week', dayOfWeek)

  if (ignoreBatchId) query = query.neq('batch_id', ignoreBatchId)

  const { data } = await query
  if (!data?.length) return false

  for (const row of data) {
    if (
      timesOverlap(
        startTime,
        endTime,
        row.start_time.slice(0, 5),
        row.end_time.slice(0, 5)
      )
    ) {
      return `Room already hosts batch "${batchName(row.batches)}"`
    }
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
    endTime
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
