import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Safe merge of duplicate subjects / programs. Every reference to the OLD row
// is re-pointed to the NEW (canonical) one — faculty mappings, batch schedules,
// planners, tests, chapters — so nothing breaks; then the old row is deleted.
// ============================================================

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

/** Merge subject `fromId` into `toId`: move all links, then delete `fromId`. */
export async function mergeSubject(
  supabase: SupabaseClient,
  fromId: string,
  toId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!fromId || !toId || fromId === toId) return { ok: false, error: 'Pick a different target subject.' }

  // faculty_subjects has UNIQUE(faculty_id, subject_id): drop rows that would
  // collide, reassign the rest.
  const { data: fromFS } = await supabase.from('faculty_subjects').select('id, faculty_id').eq('subject_id', fromId)
  const { data: toFS } = await supabase.from('faculty_subjects').select('faculty_id').eq('subject_id', toId)
  const toFaculty = new Set((toFS ?? []).map((r) => r.faculty_id as string))
  for (const row of (fromFS ?? []) as { id: string; faculty_id: string }[]) {
    if (toFaculty.has(row.faculty_id)) await supabase.from('faculty_subjects').delete().eq('id', row.id)
    else await supabase.from('faculty_subjects').update({ subject_id: toId }).eq('id', row.id)
  }

  // Straight reassigns.
  for (const table of ['batch_schedules', 'batch_planners', 'planner_lectures', 'test_schedules']) {
    const { error } = await supabase.from(table).update({ subject_id: toId }).eq('subject_id', fromId)
    if (error) return { ok: false, error: `${table}: ${error.message}` }
  }

  // Chapters: move, skipping any whose name already exists under the target.
  const { data: fromCh } = await supabase.from('chapters').select('id, name').eq('subject_id', fromId)
  const { data: toCh } = await supabase.from('chapters').select('name').eq('subject_id', toId)
  const toNames = new Set((toCh ?? []).map((c) => norm(c.name as string)))
  for (const ch of (fromCh ?? []) as { id: string; name: string }[]) {
    if (toNames.has(norm(ch.name))) await supabase.from('chapters').delete().eq('id', ch.id) // dup (topics cascade)
    else await supabase.from('chapters').update({ subject_id: toId }).eq('id', ch.id)
  }

  const { error } = await supabase.from('subjects').delete().eq('id', fromId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Merge program `fromId` into `toId`: move batches, merge/absorb subjects,
 *  then delete `fromId`. Same-named subjects are merged via mergeSubject. */
export async function mergeProgram(
  supabase: SupabaseClient,
  fromId: string,
  toId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!fromId || !toId || fromId === toId) return { ok: false, error: 'Pick a different target program.' }

  const { error: bErr } = await supabase.from('batches').update({ program_id: toId }).eq('program_id', fromId)
  if (bErr) return { ok: false, error: `batches: ${bErr.message}` }

  const { data: fromSubs } = await supabase.from('subjects').select('id, name').eq('program_id', fromId)
  const { data: toSubs } = await supabase.from('subjects').select('id, name').eq('program_id', toId)
  const toByName = new Map((toSubs ?? []).map((s) => [norm(s.name as string), s.id as string]))

  for (const s of (fromSubs ?? []) as { id: string; name: string }[]) {
    const match = toByName.get(norm(s.name))
    if (match) {
      const r = await mergeSubject(supabase, s.id, match)
      if (!r.ok) return r
    } else {
      const { error } = await supabase.from('subjects').update({ program_id: toId }).eq('id', s.id)
      if (error) return { ok: false, error: `subject "${s.name}": ${error.message}` }
      toByName.set(norm(s.name), s.id)
    }
  }

  const { error } = await supabase.from('programs').delete().eq('id', fromId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
