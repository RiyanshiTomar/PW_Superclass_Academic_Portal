/**
 * Seed email + password logins for every app_users staff member.
 * - Generates a readable password (Superclass@NNNN) per user
 * - Creates or updates the Supabase auth user (email pre-confirmed)
 * - Links app_users.auth_id
 * - Fills the admin-visible user_credentials table
 *
 * Run once (and again anytime to reset ALL passwords):
 *   node scripts/seed-passwords.js
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY in .env (local only — never on Vercel).
 */

const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function genPassword() {
  return `Superclass@${Math.floor(1000 + Math.random() * 9000)}`
}

async function main() {
  const { data: users, error } = await supabase
    .from('app_users')
    .select('id, email, full_name')
    .order('full_name')
  if (error) throw error
  console.log(`Found ${users.length} app_users.`)

  // Map existing auth users by email (paginated).
  const authByEmail = new Map()
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    for (const u of data.users) authByEmail.set((u.email || '').toLowerCase(), u.id)
    if (data.users.length < 1000) break
  }

  const results = []
  for (const u of users) {
    const email = (u.email || '').toLowerCase()
    if (!email) continue
    const password = genPassword()
    try {
      let authId = authByEmail.get(email)
      if (authId) {
        const { error } = await supabase.auth.admin.updateUserById(authId, { password, email_confirm: true })
        if (error) throw error
      } else {
        const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
        if (error) throw error
        authId = data.user.id
      }
      await supabase.from('app_users').update({ auth_id: authId }).eq('id', u.id)
      const { error: credErr } = await supabase
        .from('user_credentials')
        .upsert({ user_id: u.id, email, password_plain: password, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      if (credErr) throw credErr
      results.push({ email, password, status: 'ok' })
    } catch (e) {
      results.push({ email, password: '—', status: 'FAIL: ' + (e.message || e) })
    }
  }

  console.table(results)
  const ok = results.filter((r) => r.status === 'ok').length
  console.log(`\nDone: ${ok}/${results.length} users now have email + password.`)
  console.log('Admins can view all of these in the portal → Admin → Credentials.')
}

main().catch((e) => { console.error(e); process.exit(1) })
