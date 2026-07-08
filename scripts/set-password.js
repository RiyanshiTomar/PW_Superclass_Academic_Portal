/**
 * Set a specific password for ONE user (create auth user if needed),
 * link app_users.auth_id, and mirror into user_credentials.
 *
 * Usage:
 *   node scripts/set-password.js <email> <password>
 * Example:
 *   node scripts/set-password.js riyanshi.tomar@pw.live Admin@1234
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY in .env (local only).
 */

const fs = require('fs')
const path = require('path')
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

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = (process.argv[2] || '').toLowerCase()
const password = process.argv[3]

if (!URL || !KEY) { console.error('Missing env (URL / SERVICE_ROLE_KEY).'); process.exit(1) }
if (!email || !password) { console.error('Usage: node scripts/set-password.js <email> <password>'); process.exit(1) }

const supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data: appUser } = await supabase.from('app_users').select('id').eq('email', email).maybeSingle()
  if (!appUser) { console.error(`No app_users row for ${email}. Add the user first.`); process.exit(1) }

  // Find existing auth user by email.
  let authId = null
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === email)
    if (hit) { authId = hit.id; break }
    if (data.users.length < 1000) break
  }

  if (authId) {
    const { error } = await supabase.auth.admin.updateUserById(authId, { password, email_confirm: true })
    if (error) throw error
  } else {
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    authId = data.user.id
  }

  await supabase.from('app_users').update({ auth_id: authId }).eq('id', appUser.id)
  await supabase.from('user_credentials').upsert(
    { user_id: appUser.id, email, password_plain: password, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  )

  console.log(`✓ Password set for ${email}`)
  console.log(`  Login with:  ${email}  /  ${password}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
