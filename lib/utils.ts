export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const PLANNER_STAGES = ['Draft', 'Faculty Assigned', 'Confirmed', 'Rework'] as const
export type PlannerStage = (typeof PLANNER_STAGES)[number]

export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export function timesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const aStart = toMinutes(startA)
  const aEnd = toMinutes(endA)
  const bStart = toMinutes(startB)
  const bEnd = toMinutes(endB)
  return aStart < bEnd && aEnd > bStart
}

export function formatTime(t: string | null): string {
  if (!t) return 'TBA'
  const [h, m] = t.split(':')
  const d = new Date()
  d.setHours(Number(h), Number(m))
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

/** Human-friendly hours from a minute total, e.g. 90 -> "1.5h", 60 -> "1h" */
export function minutesToHours(totalMinutes: number): string {
  const hours = totalMinutes / 60
  const rounded = Math.round(hours * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`
}

/** Add (or subtract) whole days to a YYYY-MM-DD string, returning YYYY-MM-DD */
export function addDaysToDate(date: string, deltaDays: number): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + deltaDays)
  return d.toISOString().split('T')[0]
}

/** Whole-day difference between two YYYY-MM-DD strings (b - a) */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00').getTime()
  const db = new Date(b + 'T12:00:00').getTime()
  return Math.round((db - da) / 86_400_000)
}

/** Split one CSV line into cells, respecting quoted fields. */
export function splitCSVLine(line: string): string[] {
  const row: string[] = []
  let current = ''
  let inQuotes = false
  for (let j = 0; j < line.length; j++) {
    const char = line[j]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ',' && !inQuotes) { row.push(current.trim()); current = '' }
    else current += char
  }
  row.push(current.trim().replace(/^"|"$/g, ''))
  return row
}

/** Parse CSV keeping the header row so columns can be matched by name (any order). */
export function parseCSVWithHeaders(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = splitCSVLine(lines[0]).map((h) => h.toLowerCase().trim())
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVLine(lines[i])
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return { headers, rows }
}

/** Parse CSV rows respecting quoted fields (drops the header row) */
export function parseCSV(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length <= 1) return []

  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    const row: string[] = []
    let current = ''
    let inQuotes = false

    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j]
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    row.push(current.trim().replace(/^"|"$/g, ''))
    if (row.some((cell) => cell.length > 0)) rows.push(row)
  }
  return rows
}

export function stageBadgeClass(stage: string): string {
  switch (stage) {
    case 'Draft':
      return 'bg-neutral-100 text-neutral-600 ring-neutral-200'
    case 'Faculty Assigned':
      return 'bg-violet-50 text-violet-700 ring-violet-200'
    case 'Confirmed':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    case 'Rework':
      return 'bg-amber-50 text-amber-700 ring-amber-200'
    default:
      return 'bg-neutral-100 text-neutral-600 ring-neutral-200'
  }
}
