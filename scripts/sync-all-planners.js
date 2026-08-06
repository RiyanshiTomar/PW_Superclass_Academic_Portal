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

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

async function main() {
  const todayStr = '2026-08-05' // Use today's date from ADDITIONAL_METADATA

  console.log('Starting sync of upcoming batch planners with weekly schedules...')

  // Fetch all batch schedules
  const { data: schedules, error: sErr } = await sb
    .from('batch_schedules')
    .select('batch_id, day_of_week, start_time, end_time, subject_id, classroom_id, effective_from, effective_to')

  if (sErr) {
    console.error('Error fetching schedules:', sErr.message)
    return
  }

  // Fetch all upcoming non-conducted batch planners
  const { data: planners, error: pErr } = await sb
    .from('batch_planners')
    .select('id, batch_id, planned_date, start_time, duration_minutes, subject_id, classroom_id, topic_name, stage')
    .gte('planned_date', todayStr)

  if (pErr) {
    console.error('Error fetching planners:', pErr.message)
    return
  }

  console.log(`Found ${planners.length} upcoming planner lectures.`)

  let updatedCount = 0

  for (const p of planners) {
    const dow = new Date(p.planned_date + 'T12:00:00').getDay()

    // Find a matching weekly slot
    const slot = schedules.find(s => 
      s.batch_id === p.batch_id && 
      s.subject_id === p.subject_id && 
      s.day_of_week === dow &&
      (!s.effective_from || p.planned_date >= s.effective_from) &&
      (!s.effective_to || p.planned_date <= s.effective_to)
    )

    if (slot) {
      const targetStart = slot.start_time
      const targetDuration = toMinutes(slot.end_time.slice(0, 5)) - toMinutes(slot.start_time.slice(0, 5))
      const targetClassroom = slot.classroom_id

      if (p.start_time !== targetStart || p.duration_minutes !== targetDuration || p.classroom_id !== targetClassroom) {
        console.log(`Syncing planner row ${p.id} (${p.topic_name || 'No Topic'}) on ${p.planned_date}:`)
        console.log(`  Current: start=${p.start_time}, duration=${p.duration_minutes}, room=${p.classroom_id}`)
        console.log(`  Target:  start=${targetStart}, duration=${targetDuration}, room=${targetClassroom}`)

        const { error: uErr } = await sb
          .from('batch_planners')
          .update({
            start_time: targetStart,
            duration_minutes: targetDuration,
            classroom_id: targetClassroom
          })
          .eq('id', p.id)

        if (uErr) {
          console.error(`  Error updating row ${p.id}:`, uErr.message)
        } else {
          updatedCount++
        }
      }
    }
  }

  console.log(`\nSync complete. Updated ${updatedCount} planner lectures.`)
}

main()
