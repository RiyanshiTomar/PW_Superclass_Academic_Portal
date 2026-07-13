/**
 * Sync students from the "PW Superclass Student Dump" Google Sheet into Supabase.
 *   - Reads the sheet via the Google service account (read-only)
 *   - Upserts regno + name + centre into `students` (matched by regno)
 *   - NEVER writes batch_id — batch assignment is the Branch Head's job, so
 *     re-syncing (even when students grow) preserves existing assignments.
 *
 * Centre names differ between the sheet ("Jaipur - Tonk Road Superclass") and
 * the portal ("Jaipur Superclass"), so we map by keyword (Jaipur, Patna,
 * Pitampura, Laxmi Nagar, …).
 *
 * Run:  npm run sync-students
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
const SHEET_ID = process.env.STUDENTS_SHEET_ID || '15R2nQmc7kwFr2VfTnQ-TsAPR4hdvrVRchbalvqliLI4'
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.cwd(), 'service-account.json')

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1) }
if (!fs.existsSync(SA_PATH)) { console.error(`Missing service account key at ${SA_PATH}.`); process.exit(1) }

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

async function main() {
  const token = await getAccessToken()
  const auth = { headers: { Authorization: `Bearer ${token}` } }

  // Find the tab that actually has a `regno` column (sheet has Info + Data tabs).
  const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, auth).then((r) => r.json())
  const titles = (meta.sheets || []).map((s) => s.properties.title)
  if (titles.length === 0) throw new Error('Could not read sheet tabs: ' + JSON.stringify(meta))

  let rows = null, header = null
  for (const tab of titles) {
    const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}`, auth).then((r) => r.json())
    const vals = data.values || []
    if (vals.length < 2) continue
    const h = vals[0].map((x) => String(x).toLowerCase().trim())
    if (h.some((x) => x === 'regno' || x.includes('regno'))) { rows = vals; header = h; console.log(`Reading tab: ${tab}`); break }
  }
  if (!rows) throw new Error('No tab with a "regno" column found.')

  const col = (...keys) => header.findIndex((h) => keys.some((k) => h === k || h.includes(k)))
  // Name: prefer the exact student_name column; only fall back to a bare "name"
  // header (never match source_name / other *_name columns).
  let iName = header.findIndex((h) => h === 'student_name' || h === 'student name' || h.includes('student_name'))
  if (iName < 0) iName = header.findIndex((h) => h === 'name' || h === 'full name')
  const idx = {
    regno: col('regno'),
    name: iName,
    center: col('center', 'centre'),
    // Exact 'batch' only — not batch_start_date / batch_end_date / batch_id.
    batch: header.findIndex((h) => h === 'batch'),
  }
  if (idx.regno < 0) throw new Error('Sheet needs a regno column.')

  // Build centre keyword map from the portal's centres.
  const { data: centres } = await supabase.from('centres').select('id, name')
  const centreKeys = (centres || []).map((c) => ({ id: c.id, key: c.name.toLowerCase().replace('superclass', '').trim() }))
  const matchCentre = (raw) => {
    const s = String(raw || '').toLowerCase()
    const hit = centreKeys.find((c) => c.key && s.includes(c.key))
    return hit ? hit.id : null
  }

  const get = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '')
  const seen = new Set()
  const records = []
  let skipped = 0, unmatchedCentre = 0
  for (let r = 1; r < rows.length; r++) {
    const regno = get(rows[r], idx.regno)
    if (!regno || seen.has(regno)) { if (!regno) skipped++; continue }
    seen.add(regno)
    const centre_id = matchCentre(get(rows[r], idx.center))
    if (!centre_id) unmatchedCentre++
    records.push({
      regno,
      student_name: get(rows[r], idx.name),
      centre_id,                       // NOTE: no batch_id — preserves assignments on re-sync
      sheet_batch: get(rows[r], idx.batch) || null,   // hint only; branch head still assigns the portal batch
      updated_at: new Date().toISOString(),
    })
  }

  console.log(`Parsed ${records.length} students (${skipped} skipped, ${unmatchedCentre} with no matching centre).`)
  let done = 0
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500)
    const { error } = await supabase.from('students').upsert(chunk, { onConflict: 'regno' })
    if (error) { console.error('Upsert error:', error.message); process.exit(1) }
    done += chunk.length
    process.stdout.write(`\rUpserted ${done}/${records.length}`)
  }
  console.log(`\nDone. ${done} students synced.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
