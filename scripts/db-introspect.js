const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

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
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadDotEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env values')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function main() {
  console.log('Querying app_users columns...')
  const { data: cols, error: colErr } = await supabase
    .from('information_schema.columns')
    .select('column_name, ordinal_position, data_type, is_nullable, column_default')
    .eq('table_name', 'app_users')
    .order('ordinal_position')
  if (colErr) throw colErr
  console.log(JSON.stringify(cols, null, 2))

  console.log('Querying app_users constraints...')
  const { data: constraints, error: consErr } = await supabase
    .from('pg_catalog.pg_constraint')
    .select('conname, contype, conrelid, convalidated, conkey, consrc')
    .eq('conrelid', 'app_users' /* placeholder to test */)
  if (consErr) throw consErr
  console.log(JSON.stringify(constraints, null, 2))
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
