import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Syllabus master helpers: load the program's Subject→Chapter→Topic tree
// and report how well a planner's lectures cover it (so nothing is missed),
// matched by NAME (case-insensitive) — the same basis the test scheduler uses.
// ============================================================

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

export type MasterChapter = { id: string; name: string; topics: string[] }
export type MasterSubject = { id: string; name: string; chapters: MasterChapter[] }
export type Master = {
  subjects: MasterSubject[]
  chapterNames: Set<string>   // normalised, all chapters in program
  topicNames: Set<string>     // normalised, all topics in program
}

export async function fetchMaster(supabase: SupabaseClient, programId: string): Promise<Master> {
  const empty: Master = { subjects: [], chapterNames: new Set(), topicNames: new Set() }
  if (!programId) return empty

  const { data: subs } = await supabase.from('subjects').select('id, name').eq('program_id', programId).order('name')
  const subjects = (subs ?? []) as { id: string; name: string }[]
  if (subjects.length === 0) return empty

  const { data: chaps } = await supabase.from('chapters').select('id, subject_id, name, sequence_no').in('subject_id', subjects.map((s) => s.id)).order('sequence_no')
  const chapters = (chaps ?? []) as { id: string; subject_id: string; name: string }[]

  const topicsByChapter = new Map<string, string[]>()
  if (chapters.length > 0) {
    const { data: tops } = await supabase.from('topics').select('chapter_id, name').in('chapter_id', chapters.map((c) => c.id))
    for (const t of (tops ?? []) as { chapter_id: string; name: string }[]) {
      if (!topicsByChapter.has(t.chapter_id)) topicsByChapter.set(t.chapter_id, [])
      topicsByChapter.get(t.chapter_id)!.push(t.name)
    }
  }

  const chapterNames = new Set<string>()
  const topicNames = new Set<string>()
  const out: MasterSubject[] = subjects.map((s) => ({
    id: s.id,
    name: s.name,
    chapters: chapters.filter((c) => c.subject_id === s.id).map((c) => {
      chapterNames.add(norm(c.name))
      const topics = topicsByChapter.get(c.id) ?? []
      topics.forEach((t) => topicNames.add(norm(t)))
      return { id: c.id, name: c.name, topics }
    }),
  }))
  return { subjects: out, chapterNames, topicNames }
}

export type LectureLite = { subject_id: string | null; chapter: string | null; topic_name: string | null }

export type CoverageSubject = {
  subjectId: string
  name: string
  chaptersTotal: number
  chaptersCovered: number    // fully covered (all topics taught, or chapter-name matched when no topics)
  missing: { chapter: string; missingTopics: string[] }[]  // chapters not fully covered
}
export type Coverage = {
  subjects: CoverageSubject[]
  chaptersTotal: number
  chaptersCovered: number
  unknown: string[]          // chapter names in the planner that don't exist in the master (typos?)
  hasMaster: boolean
}

/** How completely do these lectures cover the master syllabus? Flags chapters
 *  that are missed or only partly done, plus planner names not in the master. */
export function coverageReport(master: Master, lectures: LectureLite[]): Coverage {
  const hasMaster = master.subjects.some((s) => s.chapters.length > 0)

  // Taught topic/chapter names, per subject id ('' = lecture with no subject set).
  const taughtTopics = new Map<string, Set<string>>()
  const taughtChapters = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, sub: string, v: string) => {
    if (!m.has(sub)) m.set(sub, new Set())
    m.get(sub)!.add(v)
  }
  for (const l of lectures) {
    const sub = l.subject_id ?? ''
    if (l.topic_name) add(taughtTopics, sub, norm(l.topic_name))
    if (l.chapter) add(taughtChapters, sub, norm(l.chapter))
  }

  const subjects: CoverageSubject[] = []
  let chaptersTotal = 0, chaptersCovered = 0
  for (const s of master.subjects) {
    // Include lectures tagged to this subject + untagged ones (lenient).
    const topicsTaught = new Set<string>([...(taughtTopics.get(s.id) ?? []), ...(taughtTopics.get('') ?? [])])
    const chaptersTaught = new Set<string>([...(taughtChapters.get(s.id) ?? []), ...(taughtChapters.get('') ?? [])])
    let covered = 0
    const missing: { chapter: string; missingTopics: string[] }[] = []
    for (const c of s.chapters) {
      const missingTopics = c.topics.filter((t) => !topicsTaught.has(norm(t)))
      const fullyCovered = c.topics.length > 0 ? missingTopics.length === 0 : chaptersTaught.has(norm(c.name))
      if (fullyCovered) covered++
      else missing.push({ chapter: c.name, missingTopics })
    }
    subjects.push({ subjectId: s.id, name: s.name, chaptersTotal: s.chapters.length, chaptersCovered: covered, missing })
    chaptersTotal += s.chapters.length
    chaptersCovered += covered
  }

  // Unknown = planner chapter names not found in the master at all.
  const unknown: string[] = []
  for (const l of lectures) {
    if (!l.chapter) continue
    if (master.chapterNames.has(norm(l.chapter))) continue
    if (l.topic_name && master.topicNames.has(norm(l.topic_name))) continue // topic matched → not a typo
    const key = l.chapter.trim()
    if (key && !unknown.includes(key)) unknown.push(key)
  }

  return { subjects, chaptersTotal, chaptersCovered, unknown, hasMaster }
}
