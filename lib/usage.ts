// Usage tracking helpers shared by the tracker endpoint and the admin report.

/** India date (YYYY-MM-DD) of a moment. */
export const istDay = (d: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

/** A page path with record ids replaced, so "/central/batches/<uuid>" counts
 *  as one page: '/central/batches/:id'. */
export function sectionOf(path: string): string {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return clean
    .split('/')
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 200)
}

/** The portal a page belongs to (its first path segment). */
export const portalOf = (section: string) => section.split('/')[1] || 'home'

/** Friendly names for portal pages in the report. */
export const PORTAL_LABEL: Record<string, string> = {
  admin: 'Admin', central: 'Central Team', faculty: 'Faculty', branch: 'Branch Head',
  'batch-manager': 'Batch Manager', 'progress-reviewer': 'Progress Reviewer',
  'faculty-schedule': 'Faculty Schedule', account: 'Account', 'choose-role': 'Role picker', home: 'Home',
}
