/**
 * Import Portal Data - Seeds ALL CSV data into Supabase
 * Handles: Programs & Subjects, Centres, Branch Heads, Batch Managers,
 *           Central Team, Faculty (with multi-centre support)
 *
 * Run: npm run import-data
 */

const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

// ─── ENV ─────────────────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── CSV FILES ───────────────────────────────────────────────────────────────

const CSV_FILES = {
  programs: 'Acad Portal - Req - Programs & Subjects (2).csv',
  centres: 'Acad Portal - Req - Centres (1).csv',
  centralTeam: 'Acad Portal - Req - Central Team (1).csv',
  faculty: 'Acad Portal - Req -  Faculty (2).csv',
}

// ─── CSV PARSER (handles multi-line quoted fields) ───────────────────────────

function parseCSV(text) {
  const rows = []
  let currentRow = []
  let currentCell = ''
  let inQuotes = false

  text = text.replace(/\r\n/g, '\n')

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        currentCell += '"'
        i++
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && char === ',') {
      currentRow.push(currentCell)
      currentCell = ''
      continue
    }
    if (!inQuotes && char === '\n') {
      currentRow.push(currentCell)
      currentCell = ''
      rows.push(currentRow)
      currentRow = []
      continue
    }
    currentCell += char
  }
  if (currentCell !== '' || currentRow.length > 0) {
    currentRow.push(currentCell)
    rows.push(currentRow)
  }
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''))
}

function readCSV(filename) {
  const filePath = path.join(process.cwd(), filename)
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`)
  }
  return parseCSV(fs.readFileSync(filePath, 'utf8'))
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function trim(v) { return (v || '').trim() }

function normalizePhone(value) {
  if (!value) return null
  const digits = value.replace(/[^0-9]/g, '')
  return digits || null
}

function normalizeFacultyType(value) {
  const v = trim(value).toLowerCase()
  if (!v) return 'Permanent'
  if (v.includes('hourly') || v.includes('contract')) return 'Hourly/Contract'
  return 'Permanent'
}

// Parse multi-line centre names from faculty CSV (e.g., "Laxminagar\nPitampura")
function parseCentreNames(value) {
  if (!value) return []
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Map short centre names from CSV to full DB names
const CENTRE_NAME_MAP = {
  'jaipur': 'Jaipur Superclass',
  'laxminagar': 'Laxmi Nagar Superclass',
  'laxmi nagar': 'Laxmi Nagar Superclass',
  'pitampura': 'Pitampura Superclass',
  'patna': 'Patna Superclass',
}

function resolveCentreName(shortName) {
  const key = shortName.toLowerCase().replace(/\s+/g, ' ').trim()
  return CENTRE_NAME_MAP[key] || shortName
}

// ─── IMPORT PROGRAMS & SUBJECTS ──────────────────────────────────────────────

async function importPrograms() {
  console.log('\n--- Importing Programs & Subjects ---')
  const rows = readCSV(CSV_FILES.programs)
  if (rows.length <= 1) { console.log('No program data'); return }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const progIdx = header.findIndex((h) => h.includes('program'))
  const subIdx = header.findIndex((h) => h.includes('subject'))

  if (progIdx === -1 || subIdx === -1) throw new Error('Programs CSV: missing columns')

  for (const row of rows.slice(1)) {
    const programName = trim(row[progIdx])
    const subjectValue = trim(row[subIdx]).replace(/^subjects:\s*/i, '')
    if (!programName || !subjectValue) continue

    const subjectNames = subjectValue.split(',').map((s) => s.trim()).filter(Boolean)

    // Upsert program
    const { data: prog, error: progErr } = await supabase
      .from('programs')
      .upsert({ name: programName }, { onConflict: 'name' })
      .select('id')
      .single()
    if (progErr) throw progErr

    // Upsert subjects
    for (const subName of subjectNames) {
      const { error } = await supabase
        .from('subjects')
        .upsert({ program_id: prog.id, name: subName }, { onConflict: 'program_id,name' })
      if (error) throw error
    }
    console.log(`  Program: ${programName} (${subjectNames.length} subjects)`)
  }
}

// ─── IMPORT CENTRES + BRANCH HEADS + BATCH MANAGERS ──────────────────────────

async function importCentres() {
  console.log('\n--- Importing Centres, Branch Heads, Batch Managers ---')
  const rows = readCSV(CSV_FILES.centres)
  if (rows.length <= 1) { console.log('No centre data'); return }

  // Header: Centre Name, City, Branch Head, Batch Managers
  for (const row of rows.slice(1)) {
    const centreName = trim(row[0])
    const city = trim(row[1])
    const branchHeadNames = trim(row[2])
    const batchManagerNames = trim(row[3])

    if (!centreName) continue

    // Upsert centre (without branch_head_id first)
    const { data: centre, error: centreErr } = await supabase
      .from('centres')
      .upsert({ name: centreName, city, is_active: true }, { onConflict: 'name' })
      .select('id')
      .single()
    if (centreErr) throw centreErr

    console.log(`  Centre: ${centreName} (${city})`)

    // Create branch head users
    const bhNames = branchHeadNames.split(/,/).map((s) => s.trim()).filter(Boolean)
    let firstBhId = null
    for (const bhName of bhNames) {
      const email = bhName.toLowerCase().replace(/\s+/g, '.') + '@pw.live'
      const userId = await upsertUser({
        full_name: bhName,
        email,
        role: 'branch_head',
        roles: ['branch_head'],
        centreId: centre.id,
      })
      if (!firstBhId) firstBhId = userId
      console.log(`    Branch Head: ${bhName}`)
    }

    // Set branch_head_id on centre
    if (firstBhId) {
      await supabase.from('centres').update({ branch_head_id: firstBhId }).eq('id', centre.id)
    }

    // Create batch manager users
    // Split by multiple spaces or newlines (CSV has space-separated names)
    const bmNames = batchManagerNames.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean)
    for (const bmName of bmNames) {
      const email = bmName.toLowerCase().replace(/\s+/g, '.') + '@pw.live'
      await upsertUser({
        full_name: bmName,
        email,
        role: 'batch_manager',
        roles: ['batch_manager'],
        centreId: centre.id,
      })
      console.log(`    Batch Manager: ${bmName}`)
    }
  }
}

// ─── IMPORT CENTRAL TEAM ─────────────────────────────────────────────────────

async function importCentralTeam() {
  console.log('\n--- Importing Central Team ---')
  const rows = readCSV(CSV_FILES.centralTeam)
  if (rows.length === 0) { console.log('No central team data'); return }

  // CSV format: Name, Role/Title (no header or empty first row header)
  for (const row of rows) {
    const name = trim(row[0])
    const title = trim(row[1])
    if (!name) continue

    const email = name.toLowerCase().replace(/\s+/g, '.') + '@pw.live'
    await upsertUser({
      full_name: name,
      email,
      role: 'central_team',
      roles: ['central_team'],
      centreId: null,
    })
    console.log(`  Central Team: ${name} (${title})`)
  }
}

// ─── IMPORT FACULTY ──────────────────────────────────────────────────────────

async function importFaculty() {
  console.log('\n--- Importing Faculty ---')
  const rows = readCSV(CSV_FILES.faculty)
  if (rows.length <= 1) { console.log('No faculty data'); return }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const nameIdx = header.findIndex((h) => h.includes('teacher name'))
  const centreIdx = header.findIndex((h) => h.includes('center name'))
  const emailIdx = header.findIndex((h) => h.includes('mail'))
  const phoneIdx = header.findIndex((h) => h.includes('contact'))
  const subjectIdx = header.findIndex((h) => h.includes('subject'))
  const statusIdx = header.findIndex((h) => h.includes('status'))

  if (emailIdx === -1) throw new Error('Faculty CSV: no email column found')

  // Load subject map for linking
  const { data: allSubjects } = await supabase.from('subjects').select('id, name')
  const subjectMap = new Map()
  for (const s of allSubjects || []) {
    subjectMap.set(s.name.toLowerCase().trim(), s.id)
  }

  // Load centre map
  const { data: allCentres } = await supabase.from('centres').select('id, name')
  const centreMap = new Map()
  for (const c of allCentres || []) {
    centreMap.set(c.name, c.id)
  }

  for (const row of rows.slice(1)) {
    const fullName = trim(row[nameIdx]) || 'Unknown'
    const email = trim(row[emailIdx]).toLowerCase().replace(/\t/g, '')
    const phone = normalizePhone(row[phoneIdx])
    const facultyType = normalizeFacultyType(row[statusIdx])
    const centreRaw = trim(row[centreIdx])
    const subjectRaw = trim(row[subjectIdx])

    if (!email) continue

    // Parse multiple centres
    const centreNames = parseCentreNames(centreRaw)
    const resolvedCentreIds = []
    for (const cn of centreNames) {
      const fullCentreName = resolveCentreName(cn)
      const cId = centreMap.get(fullCentreName)
      if (cId) resolvedCentreIds.push(cId)
    }

    // Upsert the user
    const userId = await upsertUser({
      full_name: fullName,
      email,
      phone,
      role: 'faculty',
      roles: ['faculty'],
      facultyType,
      centreId: resolvedCentreIds[0] || null, // primary centre
    })

    // Insert into user_centres for ALL centres this faculty teaches at
    for (let i = 0; i < resolvedCentreIds.length; i++) {
      const { error } = await supabase
        .from('user_centres')
        .upsert(
          { user_id: userId, centre_id: resolvedCentreIds[i], is_primary: i === 0 },
          { onConflict: 'user_id,centre_id' }
        )
      if (error && !error.message.includes('duplicate')) throw error
    }

    // Link subjects
    const subjectNames = subjectRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    // Clear old links
    await supabase.from('faculty_subjects').delete().eq('faculty_id', userId)

    for (const subName of subjectNames) {
      const key = subName.toLowerCase().trim()
      let subId = subjectMap.get(key)

      if (!subId) {
        // Create orphan subject (no program)
        const { data, error } = await supabase
          .from('subjects')
          .insert({ name: subName, program_id: null })
          .select('id')
          .single()
        if (error) { console.warn(`    Subject insert failed: ${subName}`, error.message); continue }
        subId = data.id
        subjectMap.set(key, subId)
      }

      const { error } = await supabase
        .from('faculty_subjects')
        .upsert({ faculty_id: userId, subject_id: subId }, { onConflict: 'faculty_id,subject_id' })
      if (error) console.warn(`    faculty_subject link fail: ${error.message}`)
    }

    console.log(`  Faculty: ${fullName} (${centreNames.join(', ')}) [${subjectNames.length} subjects]`)
  }
}

// ─── UPSERT USER HELPER ──────────────────────────────────────────────────────

async function upsertUser({ full_name, email, phone, role, roles, facultyType, centreId }) {
  const { data: existing } = await supabase
    .from('app_users')
    .select('id, role, roles, centre_id')
    .eq('email', email.toLowerCase())
    .maybeSingle()

  if (existing) {
    // Merge roles
    const existingRoles = Array.isArray(existing.roles) ? existing.roles : existing.role ? [existing.role] : []
    const mergedRoles = Array.from(new Set([...existingRoles, ...roles]))

    const updatePayload = {
      full_name,
      status: 'active',
      roles: mergedRoles,
      role: mergedRoles[0] || role,
    }
    if (phone) updatePayload.phone = phone
    if (facultyType) updatePayload.faculty_type = facultyType
    if (centreId && !existing.centre_id) updatePayload.centre_id = centreId

    const { error } = await supabase.from('app_users').update(updatePayload).eq('id', existing.id)
    if (error) throw error

    // Ensure user_centres entry
    if (centreId) {
      await supabase
        .from('user_centres')
        .upsert({ user_id: existing.id, centre_id: centreId, is_primary: !existing.centre_id }, { onConflict: 'user_id,centre_id' })
    }

    return existing.id
  }

  // Insert new
  const insertPayload = {
    full_name,
    email: email.toLowerCase(),
    status: 'active',
    role,
    roles,
  }
  if (phone) insertPayload.phone = phone
  if (facultyType) insertPayload.faculty_type = facultyType
  if (centreId) insertPayload.centre_id = centreId

  const { data, error } = await supabase
    .from('app_users')
    .insert(insertPayload)
    .select('id')
    .single()
  if (error) throw error

  // Add user_centres entry
  if (centreId) {
    await supabase
      .from('user_centres')
      .upsert({ user_id: data.id, centre_id: centreId, is_primary: true }, { onConflict: 'user_id,centre_id' })
  }

  return data.id
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function run() {
  try {
    console.log('=== Superclass Portal Data Import ===')
    console.log('Using Supabase:', SUPABASE_URL)

    await importPrograms()
    await importCentres()
    await importCentralTeam()
    await importFaculty()

    console.log('\n=== Import Complete ===')
  } catch (error) {
    console.error('\nImport FAILED:', error)
    process.exit(1)
  }
}

run()
