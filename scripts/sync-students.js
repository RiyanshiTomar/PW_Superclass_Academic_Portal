/**
 * Sync students from the enrollment Google Sheet into Supabase.
 * Batch assignment remains portal-owned and is never overwritten here.
 * Run: npm run sync-students
 */
const fs = require('fs')
const path = require('path')
const { syncStudents } = require('../lib/student-sync')

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0 || line.trim().startsWith('#')) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}

async function main() {
  loadDotEnv()
  const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.cwd(), 'service-account.json')
  if (!fs.existsSync(serviceAccountPath)) throw new Error(`Missing service account key at ${serviceAccountPath}.`)
  const summary = await syncStudents({
    serviceAccount: JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    sheetId: process.env.STUDENTS_SHEET_ID,
  })
  console.log(`Done. ${summary.synced} students synced from ${summary.tab}.`)
}

main().catch((error) => { console.error(error); process.exit(1) })
