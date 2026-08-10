#!/usr/bin/env node
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
})

async function runMigration() {
  console.log('🚀 Running migration: add_faculty_type_to_rpc.sql')
  
  const sql = readFileSync('scripts/migrations/add_faculty_type_to_rpc.sql', 'utf-8')
  
  const { error } = await supabase.rpc('exec_sql', { sql_query: sql }).single()
  
  if (error) {
    // If exec_sql doesn't exist, try direct execution
    const { error: directError } = await supabase.from('_').select('*').limit(0).then(() => 
      fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify({ sql_query: sql })
      })
    )
    
    console.log('⚠️  Cannot run migration automatically via Supabase client.')
    console.log('📋 Please run this SQL manually in Supabase SQL Editor:')
    console.log('\n' + sql + '\n')
    console.log('✅ Then refresh the Test Scheduler page.')
    return
  }
  
  console.log('✅ Migration completed successfully!')
  console.log('🔄 Please refresh the Test Scheduler page to see faculty employment types.')
}

runMigration().catch(err => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
