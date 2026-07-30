const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const DEFAULT_STUDENTS_SHEET_ID = '15R2nQmc7kwFr2VfTnQ-TsAPR4hdvrVRchbalvqliLI4'

function normalise(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/superclass|pw\s*superclass|centre|center|branch/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function significantTokens(value) {
  return normalise(value).split(' ').filter((token) => token.length >= 3 && !['road', 'nagar', 'new', 'the'].includes(token))
}

// Accept exact names, a complete portal name inside the sheet value, or one
// unique location word (e.g. Patna / Jaipur). A tie stays unmatched by design.
function matchCentre(rawCentre, centres) {
  const raw = normalise(rawCentre)
  if (!raw) return null
  const rawTokens = new Set(significantTokens(raw))
  const candidates = centres.map((centre) => {
    const name = normalise(centre.name)
    const tokens = significantTokens(centre.name)
    const shared = tokens.filter((token) => rawTokens.has(token))
    const exact = raw === name
    const containsName = Boolean(name && raw.includes(name))
    const uniqueLocation = tokens.length === 1 && rawTokens.has(tokens[0])
    const score = exact ? 1000 : containsName ? 500 + name.length : uniqueLocation ? 300 : shared.length * 10
    return { id: centre.id, score }
  }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score)
  if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return null
  return candidates[0].id
}

const b64url = (value) => Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const unsigned = `${header}.${claim}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key)
  const assertion = `${unsigned}.${b64url(signature)}`
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error(`Google authentication failed: ${JSON.stringify(data)}`)
  return data.access_token
}

async function syncStudents({ serviceAccount, supabaseUrl, serviceRoleKey, sheetId = DEFAULT_STUDENTS_SHEET_ID, log = console.log }) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error('Google service account credentials are incomplete.')
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase URL or service-role key is missing.')
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const token = await getAccessToken(serviceAccount)
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const metadata = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, auth).then((response) => response.json())
  const titles = (metadata.sheets || []).map((sheet) => sheet.properties.title)
  let tab, rows, header
  for (const title of titles) {
    const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(title)}`, auth).then((response) => response.json())
    if ((data.values || []).length < 2) continue
    const candidateHeader = data.values[0].map((cell) => String(cell).toLowerCase().trim())
    if (candidateHeader.some((column) => column === 'regno' || column.includes('regno'))) { tab = title; rows = data.values; header = candidateHeader; break }
  }
  if (!rows || !header) throw new Error('No sheet tab with a regno column was found.')
  const column = (...keys) => header.findIndex((name) => keys.some((key) => name === key || name.includes(key)))
  const exactName = header.findIndex((name) => name === 'student_name' || name === 'student name' || name.includes('student_name'))
  const indices = { regno: column('regno'), name: exactName >= 0 ? exactName : header.findIndex((name) => name === 'name' || name === 'full name'), centre: column('center', 'centre'), batch: header.findIndex((name) => name === 'batch') }
  if (indices.regno < 0) throw new Error('The student sheet needs a regno column.')
  const { data: centres, error: centresError } = await supabase.from('centres').select('id, name')
  if (centresError) throw new Error(`Could not read portal centres: ${centresError.message}`)
  const get = (row, index) => index >= 0 ? String(row[index] ?? '').trim() : ''
  const seen = new Set(), records = []
  let skipped = 0, unmatchedCentre = 0
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const regno = get(rows[rowIndex], indices.regno)
    if (!regno || seen.has(regno)) { if (!regno) skipped++; continue }
    seen.add(regno)
    const centreId = matchCentre(get(rows[rowIndex], indices.centre), centres || [])
    if (!centreId) unmatchedCentre++
    records.push({ regno, student_name: get(rows[rowIndex], indices.name), centre_id: centreId, sheet_batch: get(rows[rowIndex], indices.batch) || null, updated_at: new Date().toISOString() })
  }
  let synced = 0
  for (let start = 0; start < records.length; start += 500) {
    const { error } = await supabase.from('students').upsert(records.slice(start, start + 500), { onConflict: 'regno' })
    if (error) throw new Error(`Student upsert failed: ${error.message}`)
    synced += Math.min(500, records.length - start)
  }
  const summary = { tab, sourceRows: rows.length - 1, synced, skipped, unmatchedCentre }
  log(`Student sync complete: ${JSON.stringify(summary)}`)
  return summary
}

module.exports = { DEFAULT_STUDENTS_SHEET_ID, matchCentre, normalise, syncStudents }
