/**
 * Sync attendance from the biometric Google Sheet into Supabase.
 *   - Reads the sheet via a Google service account (Sheets API, read-only)
 *   - Upserts rows into the `attendance` table (service role)
 *
 * Setup (once):
 *   1. Create a Google service account, enable Google Sheets API, download its JSON key.
 *   2. Save that JSON as  service-account.json  in the project root (gitignored).
 *   3. Share the attendance sheet with the service account's email (Viewer).
 *   4. (Optional) set ATTENDANCE_SHEET_ID / ATTENDANCE_SHEET_TAB in .env.
 *
 * Run (and re-run anytime the sheet updates, or via cron):
 *   npm run sync-attendance
 *
 * No Google creds ever go to Vercel — this runs locally / on a trusted box.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SHEET_ID = process.env.ATTENDANCE_SHEET_ID || '131E9hDKgfAvqjtuIi-eIXFyN9nIFnu27wfkD3g0tS8A'
const SHEET_TAB = process.env.ATTENDANCE_SHEET_TAB || ''
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.cwd(), 'service-account.json')

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1) }
if (!fs.existsSync(SA_PATH)) { console.error(`Missing service account key at ${SA_PATH}. Save your Google service-account JSON there.`); process.exit(1) }

const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const b64url = (s) => Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const b64urlBuf = (b) => b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }))
  const unsigned = `${header}.${claim}`
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key)
  const jwt = `${unsigned}.${b64urlBuf(sig)}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error('Auth failed: ' + JSON.stringify(j))
  return j.access_token
}

// Normalise many date formats to YYYY-MM-DD (assumes DD/MM/YYYY when ambiguous — India).
function toISODate(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (m) {
    let [, d, mo, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const t = new Date(s)
  if (!Number.isNaN(t.getTime())) return t.toISOString().split('T')[0]
  return null
}

async function main() {
  const token = await getAccessToken()
  const auth = { headers: { Authorization: `Bearer ${token}` } }

  let tab = SHEET_TAB
  if (!tab) {
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, auth).then((r) => r.json())
    tab = meta.sheets?.[0]?.properties?.title
    if (!tab) throw new Error('Could not read sheet tabs: ' + JSON.stringify(meta))
  }
  console.log(`Reading sheet tab: ${tab}`)

  const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}`, auth).then((r) => r.json())
  const rows = data.values || []
  if (rows.length < 2) { console.log('No data rows found.'); return }

  const header = rows[0].map((h) => String(h).toLowerCase().trim())
  const col = (...keys) => header.findIndex((h) => keys.some((k) => h === k || h.includes(k)))
  const idx = {
    regno: col('regno', 'reg no', 'student id', 'studentid'),
    name: col('student_name', 'student name', 'name'),
    mobile: col('mobile'),
    center: col('center', 'centre'),
    scheme: col('scheme'),
    course: col('course'),
    status: col('admission_status', 'admission', 'status'),
    batchId: col('batch_id', 'batchid'),
    batch: col('batch'),
    date: col('attendance_date', 'date'),
    pin: col('first_punch_in', 'punch_in', 'punch in', 'first punch'),
    pout: col('last_punch_out', 'punch_out', 'punch out', 'last punch'),
  }
  if (idx.regno < 0 || idx.date < 0) { throw new Error('Sheet must have regno and attendance_date columns. Header: ' + header.join(', ')) }

  const get = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '')
  const records = []
  let skipped = 0
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const regno = get(row, idx.regno)
    const date = toISODate(get(row, idx.date))
    if (!regno || !date) { skipped++; continue }
    records.push({
      regno,
      student_name: get(row, idx.name),
      mobile_no: get(row, idx.mobile) || null,
      center: get(row, idx.center) || null,
      scheme: get(row, idx.scheme) || null,
      course: get(row, idx.course) || null,
      admission_status: get(row, idx.status) || null,
      sheet_batch_id: get(row, idx.batchId) || null,
      batch_name: get(row, idx.batch) || null,
      attendance_date: date,
      first_punch_in: get(row, idx.pin) || null,
      last_punch_out: get(row, idx.pout) || null,
    })
  }

  console.log(`Parsed ${records.length} rows (${skipped} skipped).`)
  let done = 0
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500)
    const { error } = await supabase.from('attendance').upsert(chunk, { onConflict: 'regno,attendance_date,batch_name' })
    if (error) { console.error('Upsert error:', error.message); process.exit(1) }
    done += chunk.length
    process.stdout.write(`\rUpserted ${done}/${records.length}`)
  }
  console.log(`\nDone. ${done} attendance rows synced.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
