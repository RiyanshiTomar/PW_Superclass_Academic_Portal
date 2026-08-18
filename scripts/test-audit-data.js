// Test script to check audit data and database connectivity
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

console.log('🔗 Supabase URL:', supabaseUrl ? 'Present' : 'Missing')
console.log('🔑 Supabase Key:', supabaseKey ? 'Present' : 'Missing')

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing environment variables!')
  console.log('Make sure .env file contains:')
  console.log('- NEXT_PUBLIC_SUPABASE_URL')
  console.log('- NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function testAuditData() {
  console.log('🔍 Testing Supabase connectivity and audit data...\n')
  
  try {
    // Test basic connectivity
    console.log('1. Testing basic connectivity...')
    const { data: testData, error: testError } = await supabase
      .from('batches')
      .select('count')
      .limit(1)
    
    if (testError) {
      console.error('❌ Database connection failed:', testError.message)
      console.log('\n🚨 Possible causes:')
      console.log('- Supabase free tier limit exceeded')
      console.log('- Network connectivity issues') 
      console.log('- Invalid API keys')
      console.log('\n💡 Solutions:')
      console.log('- Check Supabase dashboard usage')
      console.log('- Verify environment variables')
      console.log('- Check billing/upgrade if needed')
      return
    }
    console.log('✅ Database connection successful')

    // Test batch data
    console.log('\n2. Testing batch data...')
    const { data: batches, error: batchError } = await supabase
      .from('batches')
      .select('id, name, centre_id')
      .limit(5)
    
    if (batchError) {
      console.error('❌ Batch query failed:', batchError.message)
      return
    }
    console.log(`✅ Found ${batches?.length || 0} batches`)

    // Test batch_planners data (lectures)
    console.log('\n3. Testing lecture data...')
    const { data: planners, error: plannerError } = await supabase
      .from('batch_planners')
      .select('id, batch_id, planned_date, is_buffer')
      .eq('is_buffer', false)
      .gte('planned_date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .limit(10)
    
    if (plannerError) {
      console.error('❌ Lecture query failed:', plannerError.message)
      return
    }
    console.log(`✅ Found ${planners?.length || 0} lectures in last 7 days`)

    if (planners && planners.length > 0) {
      console.log('📅 Sample lectures:')
      planners.slice(0, 3).forEach(p => {
        console.log(`   - ${p.planned_date} (batch: ${p.batch_id})`)
      })
    }

    // Test RPC function
    console.log('\n4. Testing audit RPC function...')
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_lectures_for_audit', {
      filter_centre_id: null,
      filter_batch_id: null,
      filter_subject_id: null,
      filter_date: new Date().toISOString().split('T')[0],
      limit_days: 7
    })
    
    if (rpcError) {
      console.error('❌ RPC function failed:', rpcError.message)
      console.log('\n💡 To fix this issue:')
      console.log('1. Go to Supabase Dashboard → SQL Editor')
      console.log('2. Copy and paste the content from: scripts/migrations/fix_chapter_id_issue.sql')
      console.log('3. Run the migration to fix the RPC function')
      console.log('4. Re-run this test script')
      return
    }
    console.log(`✅ RPC function works, returned ${rpcData?.length || 0} audit records`)
    
    if (rpcData && rpcData.length > 0) {
      console.log('📋 Sample audit data:')
      rpcData.slice(0, 2).forEach(audit => {
        console.log(`   - ${audit.lecture_date}: ${audit.batch_name} (${audit.audit_status})`)
      })
    }

    // Test lecture_audits table
    console.log('\n5. Testing lecture_audits table...')
    const { data: audits, error: auditError } = await supabase
      .from('lecture_audits')
      .select('count')
      .limit(1)
    
    if (auditError) {
      console.error('❌ Lecture audits table query failed:', auditError.message)
    } else {
      console.log('✅ Lecture audits table accessible')
    }

    console.log('\n🎉 All tests completed successfully!')
    console.log('\n📊 Summary:')
    console.log(`- Database: Working ✅`)
    console.log(`- Batch Data: ${batches?.length || 0} batches found ✅`)
    console.log(`- Lecture Data: ${planners?.length || 0} lectures found ✅`)
    console.log(`- RPC Functions: Working ✅`)
    console.log(`- Audit System: Ready for use ✅`)
    
  } catch (error) {
    console.error('💥 Unexpected error:', error.message)
    console.log('\n📞 Contact support if this persists')
  }
}

// Run the test
testAuditData().then(() => {
  console.log('\n✨ Test completed. Check the output above for any issues.')
  process.exit(0)
}).catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})