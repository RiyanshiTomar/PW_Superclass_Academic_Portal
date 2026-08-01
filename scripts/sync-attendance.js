/**
 * Sync attendance from the biometric Google Sheet into Supabase.
 * Reads the sheet via a Google service account (read-only) and upserts into
 * the `attendance` table (service role). Shared logic lives in
 * lib/attendance-sync.js (also used by the Vercel cron route).
 *
 * Run: npm run sync-attendance
 */
const fs = require('fs')
const path = require('path')
const { syncAttendance } = require('../lib/attendance-sync')

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}
loadDotEnv()

async function main() {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.cwd(), 'service-account.json')
  if (!fs.existsSync(saPath)) throw new Error(`Missing service account key at ${saPath}.`)
  const summary = await syncAttendance({
    serviceAccount: JSON.parse(fs.readFileSync(saPath, 'utf8')),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    sheetId: process.env.ATTENDANCE_SHEET_ID || undefined,
    tab: process.env.ATTENDANCE_SHEET_TAB || '',
  })
  console.log(`Done. ${summary.synced} attendance rows synced from ${summary.tab}.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
