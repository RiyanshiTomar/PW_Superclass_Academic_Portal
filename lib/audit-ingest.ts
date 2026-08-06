import { createClient } from '@supabase/supabase-js'

// One camera reading at one moment, as produced by the CCTV audit engine.
export type AuditCheckInput = {
  camera_label: string
  room_no?: string | null        // matches classrooms.room_no (or .name) at the centre
  camera_type?: string | null
  checked_at: string             // ISO timestamp
  student_count?: number | null
  person_count?: number | null
  teacher_present?: boolean | null
  teacher_teaching?: boolean | null
  room_empty?: boolean | null
  activity_level?: string | null
  flagged?: boolean | null
  llm_student_count?: number | null
  llm_teacher_present?: boolean | null
  llm_agreement?: string | null
  llm_notes?: string | null
}

export type AuditIngestPayload = {
  branch_id: string              // fleet branch_id, e.g. 'patna'
  centre_name: string            // must match a centres.name, e.g. 'Superclass Patna'
  started_at?: string | null
  ended_at?: string | null
  params?: Record<string, unknown>
  checks: AuditCheckInput[]
}

/**
 * Ingest one audit run into the portal: resolve the centre by name, map each
 * camera to a classroom by room_no, upsert the session, and (re)insert its
 * per-check rows. Idempotent per (branch_id, started_at) — re-pushing the same
 * run replaces its checks rather than duplicating them.
 */
export async function ingestAudit({
  supabaseUrl,
  serviceRoleKey,
  payload,
}: {
  supabaseUrl?: string
  serviceRoleKey?: string
  payload: AuditIngestPayload
}) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase URL or service-role key is missing.')
  if (!payload?.branch_id || !payload?.centre_name) throw new Error('branch_id and centre_name are required.')

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Resolve the centre by name (case-insensitive).
  const { data: centre, error: cErr } = await supabase
    .from('centres').select('id, name').ilike('name', payload.centre_name).maybeSingle()
  if (cErr) throw new Error('Centre lookup failed: ' + cErr.message)
  if (!centre) {
    throw new Error(`No centre named "${payload.centre_name}" in the portal — create it first, or fix the branch's portal_centre_name.`)
  }

  // 2. Build a room_no/name -> classroom_id map for this centre.
  const { data: rooms, error: rErr } = await supabase
    .from('classrooms').select('id, room_no, name').eq('centre_id', centre.id)
  if (rErr) throw new Error('Classroom lookup failed: ' + rErr.message)
  const roomMap = new Map<string, string>()
  for (const room of rooms || []) {
    if (room.room_no) roomMap.set(String(room.room_no).toLowerCase().trim(), room.id)
    if (room.name) roomMap.set(String(room.name).toLowerCase().trim(), room.id)
  }

  // 3. Upsert the session (idempotent on branch_id + started_at).
  const { data: session, error: sErr } = await supabase
    .from('audit_sessions')
    .upsert(
      {
        centre_id: centre.id,
        branch_id: payload.branch_id,
        started_at: payload.started_at ?? null,
        ended_at: payload.ended_at ?? null,
        params: payload.params ?? {},
      },
      { onConflict: 'branch_id,started_at' },
    )
    .select('id').single()
  if (sErr) throw new Error('Session upsert failed: ' + sErr.message)

  // 4. Replace this session's checks (so re-push is clean, not duplicated).
  await supabase.from('audit_checks').delete().eq('session_id', session.id)

  const unmatched = new Set<string>()
  const rows = (payload.checks || []).map((c) => {
    const key = (c.room_no ?? c.camera_label ?? '').toString().toLowerCase().trim()
    const classroom_id = roomMap.get(key) ?? null
    if (!classroom_id && c.room_no) unmatched.add(String(c.room_no))
    return {
      session_id: session.id,
      centre_id: centre.id,
      classroom_id,
      camera_label: c.camera_label,
      camera_type: c.camera_type ?? null,
      checked_at: c.checked_at,
      student_count: c.student_count ?? null,
      person_count: c.person_count ?? null,
      teacher_present: c.teacher_present ?? null,
      teacher_teaching: c.teacher_teaching ?? null,
      room_empty: c.room_empty ?? null,
      activity_level: c.activity_level ?? null,
      flagged: c.flagged ?? null,
      llm_student_count: c.llm_student_count ?? null,
      llm_teacher_present: c.llm_teacher_present ?? null,
      llm_agreement: c.llm_agreement ?? null,
      llm_notes: c.llm_notes ?? null,
    }
  })

  let inserted = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await supabase.from('audit_checks').insert(chunk)
    if (error) throw new Error('audit_checks insert failed: ' + error.message)
    inserted += chunk.length
  }

  return {
    centre: centre.name,
    session_id: session.id,
    checks_inserted: inserted,
    unmatched_rooms: Array.from(unmatched),
  }
}
