/**
 * Sync CONCEPT TAGS (syllabus) + FACULTY→SUBJECT mapping from the
 * "PW Superclass — courses & faculties" Google Sheet into Supabase.
 *
 *   - Tab "All course":        Course, Subject, Chapter/Topic
 *        → upserts programs (Course) → subjects → chapters (each row = a chapter).
 *   - Tab "Active Faculties":  Center, Teacher, Exam, PW official Mail ID,
 *                              Contact, Subject (newline-separated), Status
 *        → maps each EXISTING faculty (matched by email) to their subjects
 *          (faculty_subjects), scoped to the faculty's exam/course where possible.
 *
 * ADDITIVE & idempotent: only inserts what's missing, never deletes — so re-running
 * after small syllabus edits is safe and won't break planners/tests referencing
 * existing tags. Faculty are NOT created here (only existing ones get mapped).
 *
 * Run:  npm run sync-syllabus
 * (The sheet must be shared with the service account, Viewer.)
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
const SHEET_ID = process.env.SYLLABUS_SHEET_ID || '1EzTT7dL_hwIiA-4tnzG0L_aviNF4eEJ3JJnQyYR-UNw'
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.cwd(), 'service-account.json')

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1) }
if (!fs.existsSync(SA_PATH)) { console.error(`Missing service account key at ${SA_PATH}.`); process.exit(1) }

const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

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

async function readTab(auth, titles, wanted) {
  const title = titles.find((t) => norm(t) === norm(wanted)) || titles.find((t) => norm(t).includes(norm(wanted)))
  if (!title) throw new Error(`Tab "${wanted}" not found. Tabs: ${titles.join(', ')}`)
  const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(title)}`, auth).then((r) => r.json())
  return data.values || []
}

async function main() {
  const token = await getAccessToken()
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, auth).then((r) => r.json())
  const titles = (meta.sheets || []).map((s) => s.properties.title)
  if (titles.length === 0) throw new Error('Could not read sheet tabs (is it shared with the service account?): ' + JSON.stringify(meta))

  // ---------- CONCEPT TAGS (All course) ----------
  const courseRows = await readTab(auth, titles, 'All course')
  const ch = courseRows[0].map((x) => norm(x))
  const ci = { course: ch.findIndex((h) => h.includes('course')), subject: ch.findIndex((h) => h.includes('subject')), chapter: ch.findIndex((h) => h.includes('chapter') || h.includes('topic')) }
  if (ci.course < 0 || ci.subject < 0 || ci.chapter < 0) throw new Error('All course tab needs Course, Subject, Chapter/Topic columns. Header: ' + courseRows[0].join(', '))

  const triples = []
  for (let r = 1; r < courseRows.length; r++) {
    const row = courseRows[r]
    const course = String(row[ci.course] ?? '').trim()
    const subject = String(row[ci.subject] ?? '').trim()
    const chapter = String(row[ci.chapter] ?? '').trim()
    if (!course || !subject || !chapter) continue
    triples.push({ course, subject, chapter })
  }
  console.log(`All course: ${triples.length} rows.`)

  // Programs
  const { data: existingProg } = await supabase.from('programs').select('id, name')
  const progMap = new Map((existingProg || []).map((p) => [norm(p.name), p.id]))
  const newCourses = [...new Set(triples.map((t) => t.course))].filter((c) => !progMap.has(norm(c)))
  if (newCourses.length) {
    const { data, error } = await supabase.from('programs').insert(newCourses.map((name) => ({ name }))).select('id, name')
    if (error) throw new Error('programs: ' + error.message)
    data.forEach((p) => progMap.set(norm(p.name), p.id))
  }

  // Subjects
  const { data: existingSub } = await supabase.from('subjects').select('id, name, program_id')
  const subMap = new Map((existingSub || []).map((s) => [`${s.program_id}|${norm(s.name)}`, s.id]))
  const newSubs = []
  const seenSub = new Set()
  for (const t of triples) {
    const pid = progMap.get(norm(t.course))
    const key = `${pid}|${norm(t.subject)}`
    if (!pid || subMap.has(key) || seenSub.has(key)) continue
    seenSub.add(key)
    newSubs.push({ program_id: pid, name: t.subject, _key: key })
  }
  if (newSubs.length) {
    const { data, error } = await supabase.from('subjects').insert(newSubs.map((s) => ({ program_id: s.program_id, name: s.name }))).select('id, name, program_id')
    if (error) throw new Error('subjects: ' + error.message)
    data.forEach((s) => subMap.set(`${s.program_id}|${norm(s.name)}`, s.id))
  }

  // Chapters (each row's Chapter/Topic = a chapter under the subject)
  const { data: existingChap } = await supabase.from('chapters').select('id, name, subject_id, sequence_no')
  const chapMap = new Map((existingChap || []).map((c) => [`${c.subject_id}|${norm(c.name)}`, c.id]))
  const maxSeq = new Map()
  for (const c of existingChap || []) maxSeq.set(c.subject_id, Math.max(maxSeq.get(c.subject_id) || 0, c.sequence_no || 0))
  const newChaps = []
  const seenChap = new Set()
  for (const t of triples) {
    const pid = progMap.get(norm(t.course))
    const sid = subMap.get(`${pid}|${norm(t.subject)}`)
    if (!sid) continue
    const key = `${sid}|${norm(t.chapter)}`
    if (chapMap.has(key) || seenChap.has(key)) continue
    seenChap.add(key)
    const seq = (maxSeq.get(sid) || 0) + 1
    maxSeq.set(sid, seq)
    newChaps.push({ subject_id: sid, name: t.chapter, sequence_no: seq })
  }
  if (newChaps.length) {
    for (let i = 0; i < newChaps.length; i += 500) {
      const { error } = await supabase.from('chapters').insert(newChaps.slice(i, i + 500))
      if (error) throw new Error('chapters: ' + error.message)
    }
  }
  console.log(`Concept tags → +${newCourses.length} courses, +${newSubs.length} subjects, +${newChaps.length} chapters (existing kept).`)

  // ---------- FACULTY → SUBJECT mapping (Active Faculties) ----------
  const facRows = await readTab(auth, titles, 'Active Faculties')
  const fh = facRows[0].map((x) => norm(x))
  const fi = {
    email: fh.findIndex((h) => h.includes('mail') || h.includes('email')),
    exam: fh.findIndex((h) => h.includes('exam') || h.includes('course')),
    subject: fh.findIndex((h) => h === 'subject' || h.includes('subject')),
  }
  if (fi.email < 0 || fi.subject < 0) throw new Error('Active Faculties tab needs a Mail ID and a Subject column. Header: ' + facRows[0].join(', '))

  const { data: users } = await supabase.from('app_users').select('id, email')
  const userByEmail = new Map((users || []).map((u) => [String(u.email || '').toLowerCase(), u.id]))
  // subject name → [{ id, program_id }]
  const { data: allSubs } = await supabase.from('subjects').select('id, name, program_id')
  const subjByName = new Map()
  for (const s of allSubs || []) {
    const k = norm(s.name)
    if (!subjByName.has(k)) subjByName.set(k, [])
    subjByName.get(k).push({ id: s.id, program_id: s.program_id })
  }

  const splitMulti = (v) => String(v ?? '').split(/[\n;,]+/).map((x) => x.trim()).filter(Boolean)
  const mappings = new Map() // `${fid}|${sid}` -> {faculty_id, subject_id}
  const unmatchedNames = new Set()
  let unmatchedFac = 0, unmatchedSubj = 0, matchedFac = 0
  for (let r = 1; r < facRows.length; r++) {
    const row = facRows[r]
    const email = String(row[fi.email] ?? '').trim().toLowerCase()
    if (!email) continue
    const fid = userByEmail.get(email)
    if (!fid) { unmatchedFac++; continue }
    matchedFac++
    const examProgIds = new Set(splitMulti(fi.exam >= 0 ? row[fi.exam] : '').map((e) => progMap.get(norm(e))).filter(Boolean))
    for (const subName of splitMulti(row[fi.subject])) {
      const cands = subjByName.get(norm(subName)) || []
      if (cands.length === 0) { unmatchedSubj++; unmatchedNames.add(subName); continue }
      const scoped = examProgIds.size ? cands.filter((c) => examProgIds.has(c.program_id)) : []
      const chosen = scoped.length ? scoped : cands
      for (const c of chosen) mappings.set(`${fid}|${c.id}`, { faculty_id: fid, subject_id: c.id })
    }
  }
  const mapRows = [...mappings.values()]
  if (mapRows.length) {
    for (let i = 0; i < mapRows.length; i += 500) {
      const { error } = await supabase.from('faculty_subjects').upsert(mapRows.slice(i, i + 500), { onConflict: 'faculty_id,subject_id' })
      if (error) throw new Error('faculty_subjects: ' + error.message)
    }
  }
  console.log(`Faculty mapping → ${matchedFac} faculty matched, ${mapRows.length} subject links upserted (${unmatchedFac} faculty emails not in portal, ${unmatchedSubj} subject names not found).`)
  if (unmatchedNames.size) console.log('Unmatched subject name(s) from Active Faculties (not in concept tags):', [...unmatchedNames].map((n) => `"${n}"`).join(', '))
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
