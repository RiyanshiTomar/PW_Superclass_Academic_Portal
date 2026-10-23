import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/fetch-all'

// ============================================================
// Safe merge of duplicate subjects / programs. Every reference to the OLD row
// is re-pointed to the NEW (canonical) one — faculty mappings, batch schedules,
// planners, tests, chapters — so nothing breaks; then the old row is deleted.
// ============================================================

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

/** How many schedule slots / lectures / planner rows / tests still point at
 *  these subjects. Deleting a subject that is in use would silently blank the
 *  subject on all of them (FK is ON DELETE SET NULL) — so callers must refuse
 *  and tell the admin to merge the subject instead. */
export async function subjectUsage(
  supabase: SupabaseClient,
  subjectIds: string[]
): Promise<{ total: number; text: string }> {
  if (subjectIds.length === 0) return { total: 0, text: '' }
  const count = async (table: string) => {
    const { count: n } = await supabase.from(table).select('*', { count: 'exact', head: true }).in('subject_id', subjectIds)
    return n ?? 0
  }
  const [slots, lectures, template, tests] = await Promise.all([count('batch_schedules'), count('batch_planners'), count('planner_lectures'), count('test_schedules')])
  const parts = [
    slots && `${slots} schedule slot(s)`, lectures && `${lectures} batch lecture(s)`,
    template && `${template} planner row(s)`, tests && `${tests} test(s)`,
  ].filter(Boolean)
  return { total: slots + lectures + template + tests, text: parts.join(', ') }
}

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

const dayBefore = (d: string) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10) }

export type BatchMergePlan = {
  students: number
  schedulesEnded: number; schedulesRemoved: number
  lecturesRemoved: number; lecturesKept: number
  testsRemoved: number; testsDetached: number; testsKeptWithMarks: number; pastTestsShared: number
}

/** Merge batch `absorbedId` INTO `survivorId` from `mergeDate` (any two batches
 *  at the same centre). Before the merge date nothing of the absorbed batch is
 *  lost; from the merge date only the survivor's planner & tests run:
 *  - every student of the absorbed batch moves to the survivor;
 *  - its weekly schedule stops the day before the merge date;
 *  - its lectures from the merge date are removed (ones marked conducted stay);
 *  - its tests from the merge date are removed — a test shared with other
 *    batches just drops this batch, and a test that already has marks stays;
 *  - its earlier tests are shared with the survivor (test_batch_mappings), so
 *    the moved students' old marks show in the survivor's results;
 *  - the batch is archived: status 'Merged', merged_into, merged_on.
 *  `dryRun` only counts what would happen. */
export async function mergeBatch(
  supabase: SupabaseClient,
  args: { survivorId: string; absorbedId: string; mergeDate: string; dryRun?: boolean }
): Promise<{ ok: boolean; error?: string; plan?: BatchMergePlan }> {
  const { survivorId, absorbedId, mergeDate, dryRun } = args
  if (!survivorId || !absorbedId || survivorId === absorbedId) return { ok: false, error: 'Pick two different batches.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mergeDate)) return { ok: false, error: 'Pick the merge date.' }
  const needMigration = 'Run scripts/migration-batch-merge.sql in Supabase first (it adds the merge date to batches).'

  const { data: batches, error: bErr } = await supabase.from('batches').select('id, name, centre_id, status, start_date, merged_into').in('id', [survivorId, absorbedId])
  if (bErr) return { ok: false, error: /merged_into/.test(bErr.message) ? needMigration : bErr.message }
  const survivor = (batches ?? []).find((b) => b.id === survivorId)
  const absorbed = (batches ?? []).find((b) => b.id === absorbedId)
  if (!survivor || !absorbed) return { ok: false, error: 'Batch not found.' }
  if (survivor.centre_id !== absorbed.centre_id) return { ok: false, error: 'Both batches must be at the same centre.' }
  if (absorbed.status === 'Merged' || survivor.status === 'Merged') return { ok: false, error: 'One of these batches is already merged.' }
  if (mergeDate < absorbed.start_date) return { ok: false, error: `The merge date can’t be before ${absorbed.name} starts.` }

  // ---- What would change ----
  const [stuRes, schRes, lecRes, mapRes, ownTestRes] = await Promise.all([
    supabase.from('students').select('regno', { count: 'exact', head: true }).eq('batch_id', absorbedId),
    supabase.from('batch_schedules').select('id, effective_from, effective_to').eq('batch_id', absorbedId),
    fetchAll<{ id: string; status: string }>((a, b) => supabase.from('batch_planners').select('id, status').eq('batch_id', absorbedId).gte('planned_date', mergeDate).order('id').range(a, b)),
    supabase.from('test_batch_mappings').select('test_id').eq('batch_id', absorbedId),
    supabase.from('test_schedules').select('id').eq('batch_id', absorbedId),
  ])
  const firstErr = schRes.error?.message ?? lecRes.error ?? mapRes.error?.message ?? ownTestRes.error?.message
  if (firstErr) return { ok: false, error: firstErr }

  // Schedule rows that start on/after the merge date go; rows running across
  // it end the day before.
  const lastDay = dayBefore(mergeDate)
  const sched = (schRes.data ?? []) as { id: string; effective_from: string | null; effective_to: string | null }[]
  const schedRemove = sched.filter((r) => r.effective_from && r.effective_from >= mergeDate).map((r) => r.id)
  const schedEnd = sched.filter((r) => !(r.effective_from && r.effective_from >= mergeDate) && (!r.effective_to || r.effective_to >= mergeDate)).map((r) => r.id)

  const lecRemove = lecRes.data.filter((l) => l.status !== 'conducted').map((l) => l.id)

  // Every test this batch sits (its own or shared with other batches).
  const testIds = Array.from(new Set([...(mapRes.data ?? []).map((r) => r.test_id as string), ...(ownTestRes.data ?? []).map((r) => r.id as string)]))
  const tests: { id: string; batch_id: string; test_date: string }[] = []
  const allMaps: { test_id: string; batch_id: string }[] = []
  const withMarks = new Set<string>()
  for (let i = 0; i < testIds.length; i += 150) {
    const ids = testIds.slice(i, i + 150)
    const [t, m, r] = await Promise.all([
      supabase.from('test_schedules').select('id, batch_id, test_date').in('id', ids),
      supabase.from('test_batch_mappings').select('test_id, batch_id').in('test_id', ids),
      fetchAll<{ test_id: string }>((a, b) => supabase.from('test_results').select('test_id').in('test_id', ids).or('absent.eq.true,marks.not.is.null').order('test_id').range(a, b)),
    ])
    const e = t.error?.message ?? m.error?.message ?? r.error
    if (e) return { ok: false, error: e }
    tests.push(...((t.data ?? []) as typeof tests))
    allMaps.push(...((m.data ?? []) as typeof allMaps))
    for (const x of r.data) withMarks.add(x.test_id)
  }
  const batchesOf = (id: string) => new Set(allMaps.filter((m) => m.test_id === id).map((m) => m.batch_id))
  const othersOf = (id: string) => Array.from(batchesOf(id)).filter((b) => b !== absorbedId)

  const later = tests.filter((t) => t.test_date >= mergeDate && !withMarks.has(t.id))
  const detach = later.filter((t) => othersOf(t.id).length > 0)
  const remove = later.filter((t) => othersOf(t.id).length === 0)
  const keptWithMarks = tests.filter((t) => t.test_date >= mergeDate && withMarks.has(t.id)).length
  const share = tests.filter((t) => (t.test_date < mergeDate || withMarks.has(t.id)) && !batchesOf(t.id).has(survivorId))

  const plan: BatchMergePlan = {
    students: stuRes.count ?? 0,
    schedulesEnded: schedEnd.length, schedulesRemoved: schedRemove.length,
    lecturesRemoved: lecRemove.length, lecturesKept: lecRes.data.length - lecRemove.length,
    testsRemoved: remove.length, testsDetached: detach.length, testsKeptWithMarks: keptWithMarks, pastTestsShared: share.length,
  }
  if (dryRun) return { ok: true, plan }

  // ---- Apply ---- (merge marked first, so a half-finished run is visible)
  const { error: mErr } = await supabase.from('batches').update({ merged_into: survivorId, merged_on: mergeDate }).eq('id', absorbedId)
  if (mErr) return { ok: false, error: /merged_into|merged_on/.test(mErr.message) ? needMigration : mErr.message }

  // 1. Earlier tests also count for the survivor (old marks stay visible).
  const shareRows = share.flatMap((t) => [
    ...(batchesOf(t.id).has(absorbedId) ? [] : [{ test_id: t.id, batch_id: absorbedId }]),
    { test_id: t.id, batch_id: survivorId },
  ])
  for (let i = 0; i < shareRows.length; i += 200) {
    const { error } = await supabase.from('test_batch_mappings').upsert(shareRows.slice(i, i + 200), { onConflict: 'test_id,batch_id', ignoreDuplicates: true })
    if (error) return { ok: false, error: `tests: ${error.message}` }
  }

  // 2. Later tests: a shared one just drops this batch; its own ones go.
  for (const t of detach) {
    if (t.batch_id === absorbedId) {
      const others = othersOf(t.id)
      const { error } = await supabase.from('test_schedules').update({ batch_id: others.includes(survivorId) ? survivorId : others[0] }).eq('id', t.id)
      if (error) return { ok: false, error: `tests: ${error.message}` }
    }
    const { error } = await supabase.from('test_batch_mappings').delete().eq('test_id', t.id).eq('batch_id', absorbedId)
    if (error) return { ok: false, error: `tests: ${error.message}` }
  }
  for (let i = 0; i < remove.length; i += 150) {
    const { error } = await supabase.from('test_schedules').delete().in('id', remove.slice(i, i + 150).map((t) => t.id))
    if (error) return { ok: false, error: `tests: ${error.message}` }
  }

  // 3. Lectures from the merge date (the survivor's planner runs from then).
  for (let i = 0; i < lecRemove.length; i += 150) {
    const { error } = await supabase.from('batch_planners').delete().in('id', lecRemove.slice(i, i + 150))
    if (error) return { ok: false, error: `lectures: ${error.message}` }
  }

  // 4. Weekly schedule stops the day before the merge date.
  if (schedRemove.length) {
    const { error } = await supabase.from('batch_schedules').delete().in('id', schedRemove)
    if (error) return { ok: false, error: `schedule: ${error.message}` }
  }
  if (schedEnd.length) {
    const { error } = await supabase.from('batch_schedules').update({ effective_to: lastDay }).in('id', schedEnd)
    if (error) return { ok: false, error: `schedule: ${error.message}` }
  }

  // 5. Students join the survivor.
  const { error: sErr } = await supabase.from('students').update({ batch_id: survivorId }).eq('batch_id', absorbedId)
  if (sErr) return { ok: false, error: `students: ${sErr.message}` }

  // 6. Archive.
  const { error: aErr } = await supabase.from('batches').update({ status: 'Merged' }).eq('id', absorbedId)
  if (aErr) return { ok: false, error: aErr.message }

  return { ok: true, plan }
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
