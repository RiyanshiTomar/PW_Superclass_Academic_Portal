/** Validate YYYY-MM-DD and return Date or null */
export function parsePlannedDate(value: string): Date | null {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  const d = new Date(trimmed + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return null
  return d
}

export function isDateInRange(date: Date, start: string, end: string): boolean {
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end + 'T23:59:59')
  return date >= s && date <= e
}

export function validateBatchDates(startDate: string, endDate: string): string | null {
  if (!startDate || !endDate) return 'Start and end dates are required.'
  if (endDate < startDate) return 'End date must be on or after start date.'
  return null
}

export function validateTimeRange(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) return 'Start and end times are required.'
  if (startTime >= endTime) return 'End time must be after start time.'
  return null
}

export function minutesToTimeString(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24
  const m = totalMinutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse & bound-check a lecture duration in minutes (15–480). Returns null if invalid. */
export function parseDuration(value: string): number | null {
  const n = parseInt(value, 10)
  if (!n || n < 15 || n > 480) return null
  return n
}

/** Validate an optional HH:MM time string. Empty/undefined is allowed (returns null = no error). */
export function validateOptionalTime(value: string): string | null {
  if (!value) return null
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return 'Time must be in HH:MM format.'
  return null
}
