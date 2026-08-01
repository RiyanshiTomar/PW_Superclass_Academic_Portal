const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const DEFAULT_ATTENDANCE_SHEET_ID = '131E9hDKgfAvqjtuIi-eIXFyN9nIFnu27wfkD3g0tS8A'

const b64url = (s) => Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const b64urlBuf = (b) => b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }))
  const unsigned = `${header}.${claim}`
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key)
  const jwt = `${unsigned}.${b64urlBuf(sig)}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) throw new Error('Google authentication failed: ' + JSON.stringify(j))
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

async function syncAttendance({ serviceAccount, supabaseUrl, serviceRoleKey, sheetId = DEFAULT_ATTENDANCE_SHEET_ID, tab = '', log = console.log }) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error('Google service account credentials are incomplete.')
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase URL or service-role key is missing.')
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const token = await getAccessToken(serviceAccount)
  const auth = { headers: { Authorization: `Bearer ${token}` } }

  let sheetTab = tab
  if (!sheetTab) {
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, auth).then((r) => r.json())
    sheetTab = meta.sheets?.[0]?.properties?.title
    if (!sheetTab) throw new Error('Could not read sheet tabs: ' + JSON.stringify(meta))
  }

  const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetTab)}`, auth).then((r) => r.json())
  const rows = data.values || []
  if (rows.length < 2) { log('No data rows found.'); return { tab: sheetTab, synced: 0, skipped: 0 } }

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
  if (idx.regno < 0 || idx.date < 0) throw new Error('Sheet must have regno and attendance_date columns. Header: ' + header.join(', '))

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

  let synced = 0
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500)
    const { error } = await supabase.from('attendance').upsert(chunk, { onConflict: 'regno,attendance_date,batch_name' })
    if (error) throw new Error('Attendance upsert failed: ' + error.message)
    synced += chunk.length
  }
  const summary = { tab: sheetTab, synced, skipped }
  log(`Attendance sync complete: ${JSON.stringify(summary)}`)
  return summary
}

module.exports = { DEFAULT_ATTENDANCE_SHEET_ID, syncAttendance, toISODate }
