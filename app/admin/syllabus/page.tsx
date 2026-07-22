'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseCSVWithHeaders } from '@/lib/utils'
import { mergeSubject } from '@/lib/merge'

type Program = { id: string; name: string }
type Subject = { id: string; name: string }
type Chapter = { id: string; subject_id: string; name: string; sequence_no: number; total_hours: number | null; teaching_hours: number | null }
type Topic = { id: string; chapter_id: string; name: string; sequence_no: number }
// Where a subject/chapter is referenced, so we can warn before editing/deleting.
type Usage = { planners: string[]; lectures: number; live: number }
type Pending =
  | { kind: 'rename-subject'; subject: Subject; usage: Usage; value: string }
  | { kind: 'delete-subject'; subject: Subject; usage: Usage }
  | { kind: 'rename-chapter'; chapter: Chapter; usage: Usage; value: string }
  | { kind: 'delete-chapter'; chapter: Chapter; usage: Usage }

function one<T>(v: T | T[] | null | undefined): T | null { return !v ? null : Array.isArray(v) ? v[0] ?? null : v }
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().replace(/s$/, '')

export default function SyllabusPage() {
  const supabase = createClient()
  const [programs, setPrograms] = useState<Program[]>([])
  const [programId, setProgramId] = useState('')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [expSub, setExpSub] = useState<Set<string>>(new Set())
  const [expChap, setExpChap] = useState<Set<string>>(new Set())
  const [newSubject, setNewSubject] = useState('')
  const [newChapterFor, setNewChapterFor] = useState<string | null>(null)
  const [newChapterVal, setNewChapterVal] = useState('')
  const [newTopicFor, setNewTopicFor] = useState<string | null>(null)
  const [newTopicVal, setNewTopicVal] = useState('')
  const [mergeSubj, setMergeSubj] = useState<Subject | null>(null)
  const [mergeSubjTarget, setMergeSubjTarget] = useState('')
  const [mergingSubj, setMergingSubj] = useState(false)
  // Edit/delete with usage warning
  const [pending, setPending] = useState<Pending | null>(null)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)

  // Concept-tags library (distinct subjects + chapters across ALL programs)
  const [libOpen, setLibOpen] = useState(false)
  const [library, setLibrary] = useState<{ name: string; chapters: string[] }[]>([])
  const [libSel, setLibSel] = useState<Set<string>>(new Set())
  const [libSearch, setLibSearch] = useState('')
  const [libLoading, setLibLoading] = useState(false)
  const [libBusy, setLibBusy] = useState(false)

  useEffect(() => {
    supabase.from('programs').select('id, name').order('name').then(({ data }) => {
      if (data) setPrograms(data as Program[])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadProgram = async (pid: string) => {
    setProgramId(pid)
    setExpSub(new Set()); setExpChap(new Set()); setMsg(null)
    if (!pid) { setSubjects([]); setChapters([]); setTopics([]); return }
    setLoading(true)
    const { data: subs } = await supabase.from('subjects').select('id, name').eq('program_id', pid).order('name')
    const subjects = (subs ?? []) as Subject[]
    setSubjects(subjects)
    const subIds = subjects.map((s) => s.id)
    if (subIds.length === 0) { setChapters([]); setTopics([]); setLoading(false); return }
    let chapRes = await supabase.from('chapters').select('id, subject_id, name, sequence_no, total_hours, teaching_hours').in('subject_id', subIds).order('sequence_no')
    // Fall back if the hours columns aren't there yet (migration not run).
    if (chapRes.error) chapRes = (await supabase.from('chapters').select('id, subject_id, name, sequence_no').in('subject_id', subIds).order('sequence_no')) as typeof chapRes
    const chapters = (chapRes.data ?? []).map((c) => ({ ...(c as Chapter), total_hours: (c as Chapter).total_hours ?? null, teaching_hours: (c as Chapter).teaching_hours ?? null })) as Chapter[]
    setChapters(chapters)
    const chapIds = chapters.map((c) => c.id)
    if (chapIds.length === 0) { setTopics([]); setLoading(false); return }
    const { data: tops } = await supabase.from('topics').select('id, chapter_id, name, sequence_no').in('chapter_id', chapIds).order('sequence_no')
    setTopics((tops ?? []) as Topic[])
    setLoading(false)
  }

  const chaptersOf = (subjectId: string) => chapters.filter((c) => c.subject_id === subjectId)
  const topicsOf = (chapterId: string) => topics.filter((t) => t.chapter_id === chapterId)
  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n)
  }

  // ---- Subject CRUD --------------------------------------------------------
  const addSubject = async () => {
    const name = newSubject.trim()
    if (!name || !programId) return
    const { error } = await supabase.from('subjects').insert({ program_id: programId, name })
    if (error) return setMsg({ type: 'error', text: error.message.includes('duplicate') ? 'Subject already exists.' : error.message })
    setNewSubject(''); await loadProgram(programId)
  }
  // --- Usage lookups: which planners reference a subject / chapter -----------
  const fetchSubjectUsage = async (subjectId: string): Promise<Usage> => {
    const [lecRes, bpRes] = await Promise.all([
      supabase.from('planner_lectures').select('planner_id, planners(name)').eq('subject_id', subjectId),
      supabase.from('batch_planners').select('id', { count: 'exact', head: true }).eq('subject_id', subjectId),
    ])
    const names = new Set<string>()
    for (const r of (lecRes.data ?? []) as { planners: { name: string } | { name: string }[] | null }[]) { const p = one(r.planners); if (p?.name) names.add(p.name) }
    return { planners: Array.from(names).sort(), lectures: (lecRes.data ?? []).length, live: bpRes.count ?? 0 }
  }
  const fetchChapterUsage = async (subjectId: string, chapterName: string): Promise<Usage> => {
    const target = norm(chapterName)
    const [lecRes, bpRes] = await Promise.all([
      supabase.from('planner_lectures').select('planner_id, chapter, planners(name)').eq('subject_id', subjectId),
      supabase.from('batch_planners').select('id, chapter').eq('subject_id', subjectId),
    ])
    const rows = (lecRes.data ?? []).filter((r) => norm((r as { chapter: string }).chapter) === target)
    const names = new Set<string>()
    for (const r of rows as { planners: { name: string } | { name: string }[] | null }[]) { const p = one(r.planners); if (p?.name) names.add(p.name) }
    const live = ((bpRes.data ?? []) as { chapter: string }[]).filter((r) => norm(r.chapter) === target).length
    return { planners: Array.from(names).sort(), lectures: rows.length, live }
  }

  const askRenameSubject = async (s: Subject) => { setCheckingId(s.id); const usage = await fetchSubjectUsage(s.id); setCheckingId(null); setPending({ kind: 'rename-subject', subject: s, usage, value: s.name }) }
  const askDeleteSubject = async (s: Subject) => { setCheckingId(s.id); const usage = await fetchSubjectUsage(s.id); setCheckingId(null); setPending({ kind: 'delete-subject', subject: s, usage }) }
  const askRenameChapter = async (c: Chapter) => { setCheckingId(c.id); const usage = await fetchChapterUsage(c.subject_id, c.name); setCheckingId(null); setPending({ kind: 'rename-chapter', chapter: c, usage, value: c.name }) }
  const askDeleteChapter = async (c: Chapter) => { setCheckingId(c.id); const usage = await fetchChapterUsage(c.subject_id, c.name); setCheckingId(null); setPending({ kind: 'delete-chapter', chapter: c, usage }) }

  const confirmPending = async () => {
    if (!pending) return
    setPendingBusy(true); setMsg(null)
    try {
      if (pending.kind === 'rename-subject') {
        const name = pending.value.trim(); if (!name || name === pending.subject.name) { setPending(null); return }
        const { error } = await supabase.from('subjects').update({ name }).eq('id', pending.subject.id)
        if (error) throw error
      } else if (pending.kind === 'delete-subject') {
        const { error } = await supabase.from('subjects').delete().eq('id', pending.subject.id)
        if (error) throw new Error('Cannot delete — this subject is still linked to a batch/planner/test. Remove those first (or merge the subject).')
      } else if (pending.kind === 'rename-chapter') {
        const name = pending.value.trim(); if (!name || name === pending.chapter.name) { setPending(null); return }
        const { error } = await supabase.from('chapters').update({ name }).eq('id', pending.chapter.id)
        if (error) throw error
      } else if (pending.kind === 'delete-chapter') {
        const { error } = await supabase.from('chapters').delete().eq('id', pending.chapter.id)
        if (error) throw error
      }
      setPending(null)
      await loadProgram(programId)
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Action failed.' })
    } finally { setPendingBusy(false) }
  }

  // Build the library = every distinct subject name across all programs, with
  // the union of its chapters. Lets a new program pull standard subjects+chapters.
  const openLibrary = async () => {
    if (!programId) { setMsg({ type: 'error', text: 'Pick a program first.' }); return }
    setLibOpen(true); setLibSel(new Set()); setLibSearch(''); setLibLoading(true)
    const { data: subs } = await supabase.from('subjects').select('id, name')
    const subIds = (subs ?? []).map((s) => s.id)
    const { data: chaps } = subIds.length ? await supabase.from('chapters').select('subject_id, name, sequence_no').in('subject_id', subIds).order('sequence_no') : { data: [] as { subject_id: string; name: string }[] }
    const chBySub = new Map<string, string[]>()
    for (const c of (chaps ?? []) as { subject_id: string; name: string }[]) {
      if (!chBySub.has(c.subject_id)) chBySub.set(c.subject_id, [])
      chBySub.get(c.subject_id)!.push(c.name)
    }
    const byName = new Map<string, { name: string; chapters: string[]; seen: Set<string> }>()
    for (const s of (subs ?? []) as { id: string; name: string }[]) {
      const key = s.name.toLowerCase().trim()
      if (!byName.has(key)) byName.set(key, { name: s.name, chapters: [], seen: new Set() })
      const e = byName.get(key)!
      for (const cn of chBySub.get(s.id) ?? []) { const ck = cn.toLowerCase().trim(); if (!e.seen.has(ck)) { e.seen.add(ck); e.chapters.push(cn) } }
    }
    setLibrary(Array.from(byName.values()).map((e) => ({ name: e.name, chapters: e.chapters })).sort((a, b) => a.name.localeCompare(b.name)))
    setLibLoading(false)
  }

  const addFromLibrary = async () => {
    if (!programId || libSel.size === 0) return
    setLibBusy(true); setMsg(null)
    const chosen = library.filter((l) => libSel.has(l.name))
    await supabase.from('subjects').upsert(chosen.map((l) => ({ program_id: programId, name: l.name })), { onConflict: 'program_id,name', ignoreDuplicates: true })
    const { data: subs } = await supabase.from('subjects').select('id, name').eq('program_id', programId)
    const subId = new Map((subs ?? []).map((s) => [s.name, s.id]))
    const chapRows: { subject_id: string; name: string; sequence_no: number }[] = []
    for (const l of chosen) {
      const sid = subId.get(l.name); if (!sid) continue
      l.chapters.forEach((cn, i) => chapRows.push({ subject_id: sid, name: cn, sequence_no: i }))
    }
    if (chapRows.length) await supabase.from('chapters').upsert(chapRows, { onConflict: 'subject_id,name', ignoreDuplicates: true })
    setLibBusy(false); setLibOpen(false)
    setMsg({ type: 'success', text: `Added ${chosen.length} subject(s) with ${chapRows.length} chapter(s) to this program.` })
    await loadProgram(programId)
  }

  const handleMergeSubject = async () => {
    if (!mergeSubj || !mergeSubjTarget) return
    setMergingSubj(true); setMsg(null)
    const res = await mergeSubject(supabase, mergeSubj.id, mergeSubjTarget)
    setMergingSubj(false)
    if (!res.ok) return setMsg({ type: 'error', text: 'Merge failed: ' + (res.error ?? '') })
    const targetName = subjects.find((s) => s.id === mergeSubjTarget)?.name ?? 'target'
    setMsg({ type: 'success', text: `Merged "${mergeSubj.name}" into "${targetName}" — faculty & batch links moved over.` })
    setMergeSubj(null); setMergeSubjTarget('')
    await loadProgram(programId)
  }

  // ---- Chapter CRUD --------------------------------------------------------
  const addChapter = async (subjectId: string) => {
    const name = newChapterVal.trim()
    if (!name) return
    const seq = chaptersOf(subjectId).length
    const { error } = await supabase.from('chapters').insert({ subject_id: subjectId, name, sequence_no: seq })
    if (error) return setMsg({ type: 'error', text: error.message.includes('duplicate') ? 'Chapter already exists in this subject.' : error.message })
    setNewChapterVal(''); setNewChapterFor(null); await loadProgram(programId)
  }

  // Per-chapter hours (admin-entered). Edit locally, persist on blur.
  const setChapterHours = (id: string, field: 'total_hours' | 'teaching_hours', raw: string) => {
    const val = raw.trim() === '' ? null : Math.max(0, Number(raw))
    setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: Number.isNaN(val as number) ? c[field] : val } : c)))
  }
  const saveChapterHours = async (c: Chapter) => {
    const { error } = await supabase.from('chapters').update({ total_hours: c.total_hours, teaching_hours: c.teaching_hours }).eq('id', c.id)
    if (error) setMsg({ type: 'error', text: `Could not save hours: ${error.message}` })
  }

  // ---- Topic CRUD ----------------------------------------------------------
  const addTopic = async (chapterId: string) => {
    const name = newTopicVal.trim()
    if (!name) return
    const seq = topicsOf(chapterId).length
    const { error } = await supabase.from('topics').insert({ chapter_id: chapterId, name, sequence_no: seq })
    if (error) return setMsg({ type: 'error', text: error.message.includes('duplicate') ? 'Topic already exists in this chapter.' : error.message })
    setNewTopicVal(''); setNewTopicFor(null); await loadProgram(programId)
  }
  const renameTopic = async (t: Topic) => {
    const name = prompt('Rename topic', t.name)?.trim()
    if (!name || name === t.name) return
    const { error } = await supabase.from('topics').update({ name }).eq('id', t.id)
    if (error) return setMsg({ type: 'error', text: error.message })
    await loadProgram(programId)
  }
  const deleteTopic = async (t: Topic) => {
    if (!confirm(`Delete topic "${t.name}"?`)) return
    await supabase.from('topics').delete().eq('id', t.id)
    await loadProgram(programId)
  }

  // Import one program's Subject→Chapter→Topic tree. Returns counts processed.
  const importTree = async (pid: string, tree: Map<string, Map<string, string[]>>) => {
    await supabase.from('subjects').upsert([...tree.keys()].map((name) => ({ program_id: pid, name })), { onConflict: 'program_id,name', ignoreDuplicates: true })
    const { data: subs } = await supabase.from('subjects').select('id, name').eq('program_id', pid)
    const subId = new Map((subs ?? []).map((s) => [s.name, s.id]))

    const chapRows: { subject_id: string; name: string; sequence_no: number }[] = []
    for (const [sName, cm] of tree) {
      const sid = subId.get(sName); if (!sid) continue
      let i = 0
      for (const cName of cm.keys()) chapRows.push({ subject_id: sid, name: cName, sequence_no: i++ })
    }
    if (chapRows.length) await supabase.from('chapters').upsert(chapRows, { onConflict: 'subject_id,name', ignoreDuplicates: true })
    const { data: chaps } = await supabase.from('chapters').select('id, subject_id, name').in('subject_id', [...subId.values()])
    const chapId = new Map((chaps ?? []).map((c) => [`${c.subject_id}|${c.name}`, c.id]))

    const topRows: { chapter_id: string; name: string; sequence_no: number }[] = []
    for (const [sName, cm] of tree) {
      const sid = subId.get(sName); if (!sid) continue
      for (const [cName, tps] of cm) {
        const cid = chapId.get(`${sid}|${cName}`); if (!cid) continue
        tps.forEach((tName, i) => topRows.push({ chapter_id: cid, name: tName, sequence_no: i }))
      }
    }
    if (topRows.length) await supabase.from('topics').upsert(topRows, { onConflict: 'chapter_id,name', ignoreDuplicates: true })
    return { s: tree.size, c: chapRows.length, t: topRows.length }
  }

  // ---- CSV import (Course, Subject, Chapter, Topic) ------------------------
  // A Course column routes each row to its program (created if missing). Without
  // it, everything imports under the program picked above.
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMsg(null)
    try {
      const { headers, rows } = parseCSVWithHeaders(await file.text())
      const iCourse = headers.findIndex((h) => h.includes('course') || h.includes('program'))
      const iSub = headers.findIndex((h) => h.includes('subject'))
      const iChap = headers.findIndex((h) => h.includes('chapter'))
      // Only treat a column as Topic if it's a SEPARATE column (not the combined
      // "Chapter/ Topic" header, which is a chapter list).
      const iTop = headers.findIndex((h) => h.includes('topic') && !h.includes('chapter'))
      if (iSub < 0 || iChap < 0) { setMsg({ type: 'error', text: 'CSV needs Subject and Chapter columns (Course & Topic optional).' }); return }
      const useCourse = iCourse >= 0
      if (!useCourse && !programId) { setMsg({ type: 'error', text: 'Pick a program above, or add a Course column to the CSV.' }); return }

      // course -> subject -> chapter -> [topics]
      const byCourse = new Map<string, Map<string, Map<string, string[]>>>()
      for (const row of rows) {
        const course = useCourse ? (row[iCourse] ?? '').trim() : '__SEL__'
        const s = (row[iSub] ?? '').trim()
        const c = (row[iChap] ?? '').trim()
        const t = iTop >= 0 ? (row[iTop] ?? '').trim() : ''
        if (!s || !c || (useCourse && !course)) continue
        if (!byCourse.has(course)) byCourse.set(course, new Map())
        const tree = byCourse.get(course)!
        if (!tree.has(s)) tree.set(s, new Map())
        const cm = tree.get(s)!
        if (!cm.has(c)) cm.set(c, [])
        if (t && !cm.get(c)!.includes(t)) cm.get(c)!.push(t)
      }
      if (byCourse.size === 0) { setMsg({ type: 'error', text: 'No valid rows found.' }); return }

      const progByName = new Map(programs.map((p) => [p.name.toLowerCase(), p.id]))
      let createdPrograms = 0
      let totS = 0, totC = 0, totT = 0
      let lastPid = programId
      for (const [course, tree] of byCourse) {
        let pid: string
        if (useCourse) {
          pid = progByName.get(course.toLowerCase()) ?? ''
          if (!pid) {
            const { data: np } = await supabase.from('programs').insert({ name: course }).select('id').single()
            if (!np) continue
            pid = np.id; progByName.set(course.toLowerCase(), pid); createdPrograms++
          }
        } else pid = programId
        lastPid = pid
        const counts = await importTree(pid, tree)
        totS += counts.s; totC += counts.c; totT += counts.t
      }

      // Refresh programs (new ones may have been created).
      const { data: allProgs } = await supabase.from('programs').select('id, name').order('name')
      if (allProgs) setPrograms(allProgs as Program[])

      let m = `Imported ${totS} subject(s), ${totC} chapter(s)${totT ? `, ${totT} topic(s)` : ''} across ${byCourse.size} course(s).`
      if (createdPrograms) m += ` Created ${createdPrograms} new program(s).`
      setMsg({ type: 'success', text: m })
      if (lastPid) await loadProgram(lastPid)
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse CSV.' })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const totals = useMemo(() => ({ subjects: subjects.length, chapters: chapters.length, topics: topics.length }), [subjects, chapters, topics])
  const input = 'h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Syllabus / Concept Tags</h1>
          <p className="text-sm text-gray-500">Master list per program: Subject → Chapter → Topic. Used to validate planners & test coverage.</p>
        </div>
        <label className={`inline-flex items-center h-10 px-4 rounded-lg text-sm font-medium cursor-pointer ${busy ? 'bg-gray-200 text-gray-400' : 'bg-gray-900 hover:bg-gray-800 text-white'}`}>
          {busy ? 'Importing…' : 'Import CSV'}
          <input ref={fileRef} type="file" accept=".csv" className="sr-only" onChange={handleImport} disabled={busy} />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Program</label>
          <select value={programId} onChange={(e) => loadProgram(e.target.value)} className="h-10 min-w-[240px] px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Select a program</option>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {programId && <span className="text-xs text-gray-400 pb-2.5">{totals.subjects} subjects · {totals.chapters} chapters · {totals.topics} topics</span>}
      </div>

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>{msg.text}</div>}

      {!programId ? (
        <div className="p-8 text-center text-gray-400 text-sm bg-white border border-gray-200 rounded-xl">Pick a program to manage its syllabus.</div>
      ) : loading ? (
        <div className="p-8 text-center text-gray-400 text-sm bg-white border border-gray-200 rounded-xl">Loading…</div>
      ) : (
        <div className="space-y-3">
          {/* Add subject */}
          <div className="flex gap-2">
            <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSubject()} placeholder="New subject name" className={`${input} flex-1`} />
            <button onClick={addSubject} className="h-9 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">Add subject</button>
            <button onClick={openLibrary} className="h-9 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-medium whitespace-nowrap">+ From library</button>
          </div>

          {subjects.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm bg-white border border-gray-200 rounded-xl">No subjects yet. Add one above or import a CSV.</div>
          ) : subjects.map((s) => {
            const chaps = chaptersOf(s.id)
            const openS = expSub.has(s.id)
            return (
              <div key={s.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
                  <button className="flex items-center gap-2 text-left" onClick={() => toggle(expSub, s.id, setExpSub)}>
                    <span className="text-gray-400 text-xs w-3">{openS ? '▾' : '▸'}</span>
                    <span className="font-medium text-gray-900">{s.name}</span>
                    <span className="text-xs text-gray-400">{chaps.length} chapters</span>
                  </button>
                  <div className="space-x-3 text-xs">
                    <button onClick={() => askRenameSubject(s)} disabled={checkingId === s.id} className="text-blue-600 hover:underline disabled:opacity-40">{checkingId === s.id ? 'Checking…' : 'Rename'}</button>
                    <button onClick={() => { setMergeSubj(s); setMergeSubjTarget(''); setMsg(null) }} className="text-violet-600 hover:underline">Merge</button>
                    <button onClick={() => askDeleteSubject(s)} disabled={checkingId === s.id} className="text-red-600 hover:underline disabled:opacity-40">Delete</button>
                  </div>
                </div>

                {openS && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 space-y-2">
                    {chaps.map((c) => {
                      const tps = topicsOf(c.id)
                      const openC = expChap.has(c.id)
                      return (
                        <div key={c.id} className="bg-white border border-gray-200 rounded-lg">
                          <div className="flex items-center justify-between px-3 py-2">
                            <button className="flex items-center gap-2 text-left" onClick={() => toggle(expChap, c.id, setExpChap)}>
                              <span className="text-gray-400 text-xs w-3">{openC ? '▾' : '▸'}</span>
                              <span className="text-sm font-medium text-gray-800">{c.name}</span>
                              <span className="text-[11px] text-gray-400">{tps.length} topics</span>
                            </button>
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1 text-[11px] text-gray-500" title="Total hours this chapter is worth">
                                  <span className="uppercase tracking-wide font-semibold">Total</span>
                                  <input type="number" min={0} step="0.5" value={c.total_hours ?? ''} onChange={(e) => setChapterHours(c.id, 'total_hours', e.target.value)} onBlur={() => saveChapterHours(c)} placeholder="—" className="w-16 h-7 px-1.5 border border-gray-200 rounded-md text-xs text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                  <span className="text-gray-400">h</span>
                                </label>
                                <label className="flex items-center gap-1 text-[11px] text-gray-500" title="Hours actually spent teaching">
                                  <span className="uppercase tracking-wide font-semibold">Teaching</span>
                                  <input type="number" min={0} step="0.5" value={c.teaching_hours ?? ''} onChange={(e) => setChapterHours(c.id, 'teaching_hours', e.target.value)} onBlur={() => saveChapterHours(c)} placeholder="—" className="w-16 h-7 px-1.5 border border-gray-200 rounded-md text-xs text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                  <span className="text-gray-400">h</span>
                                </label>
                              </div>
                              <div className="space-x-2 text-xs whitespace-nowrap">
                                <button onClick={() => askRenameChapter(c)} disabled={checkingId === c.id} className="text-blue-600 hover:underline disabled:opacity-40">{checkingId === c.id ? 'Checking…' : 'Rename'}</button>
                                <button onClick={() => askDeleteChapter(c)} disabled={checkingId === c.id} className="text-red-600 hover:underline disabled:opacity-40">Delete</button>
                              </div>
                            </div>
                          </div>
                          {openC && (
                            <div className="border-t border-gray-100 px-3 py-2 space-y-1">
                              {tps.map((t) => (
                                <div key={t.id} className="flex items-center justify-between text-sm pl-5">
                                  <span className="text-gray-700">• {t.name}</span>
                                  <div className="space-x-2 text-xs">
                                    <button onClick={() => renameTopic(t)} className="text-blue-600 hover:underline">Rename</button>
                                    <button onClick={() => deleteTopic(t)} className="text-gray-400 hover:text-red-600">✕</button>
                                  </div>
                                </div>
                              ))}
                              <div className="flex gap-2 pt-1 pl-5">
                                {newTopicFor === c.id ? (
                                  <>
                                    <input autoFocus value={newTopicVal} onChange={(e) => setNewTopicVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTopic(c.id)} placeholder="Topic name" className={`${input} h-8 flex-1`} />
                                    <button onClick={() => addTopic(c.id)} className="h-8 px-3 bg-blue-600 text-white rounded-lg text-xs font-medium">Add</button>
                                    <button onClick={() => { setNewTopicFor(null); setNewTopicVal('') }} className="h-8 px-2 text-gray-500 text-xs">Cancel</button>
                                  </>
                                ) : (
                                  <button onClick={() => { setNewTopicFor(c.id); setNewTopicVal('') }} className="text-xs text-blue-600 hover:underline">+ Add topic</button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <div className="flex gap-2 pt-1">
                      {newChapterFor === s.id ? (
                        <>
                          <input autoFocus value={newChapterVal} onChange={(e) => setNewChapterVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addChapter(s.id)} placeholder="Chapter name" className={`${input} h-8 flex-1`} />
                          <button onClick={() => addChapter(s.id)} className="h-8 px-3 bg-blue-600 text-white rounded-lg text-xs font-medium">Add</button>
                          <button onClick={() => { setNewChapterFor(null); setNewChapterVal('') }} className="h-8 px-2 text-gray-500 text-xs">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => { setNewChapterFor(s.id); setNewChapterVal('') }} className="text-xs text-blue-600 hover:underline">+ Add chapter</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
        <p className="font-semibold mb-1">CSV import format</p>
        <code className="bg-white px-2 py-1 rounded border border-blue-200">Course, Subject, Chapter, Topic</code>
        <p className="mt-1"><span className="font-semibold">Course</span> is optional — if present, each row goes to that program (created if it doesn’t exist), so one file can load every course at once. Without it, everything imports under the program picked above. <span className="font-semibold">Topic</span> is optional too (chapter-only rows work). Existing rows are skipped — safe to re-import.</p>
      </div>

      {pending && (() => {
        const isRename = pending.kind === 'rename-subject' || pending.kind === 'rename-chapter'
        const isChapter = 'chapter' in pending
        const name = 'chapter' in pending ? pending.chapter.name : pending.subject.name
        const u = pending.usage
        const mapped = u.planners.length > 0 || u.lectures > 0 || u.live > 0
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => !pendingBusy && setPending(null)}>
            <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-gray-200 p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-semibold text-gray-900 mb-1">{isRename ? 'Rename' : 'Delete'} {isChapter ? 'chapter' : 'subject'}</h3>
              <p className="text-sm text-gray-500 mb-4">{isChapter ? 'Chapter' : 'Subject'}: <span className="font-semibold text-gray-800">{name}</span></p>

              {mapped ? (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                  <p className="font-semibold mb-1">⚠ This is mapped in existing planners</p>
                  <p className="mb-1.5">{u.planners.length} planner(s) · {u.lectures} planned + {u.live} scheduled lecture(s) use this {isChapter ? 'chapter' : 'subject'}.</p>
                  {u.planners.length > 0 && <p className="text-amber-700"><span className="font-medium">Planners:</span> {u.planners.slice(0, 8).join(', ')}{u.planners.length > 8 ? ` +${u.planners.length - 8} more` : ''}</p>}
                  <p className="mt-1.5">
                    {isChapter
                      ? (isRename
                        ? 'Chapter names are stored as text in planners — after renaming here, open Edit Planner and update the chapter in these planners too, otherwise their concept-tag validation will fail.'
                        : 'These planners reference this chapter by name — after deleting it, fix them in Edit Planner (else the chapter is no longer in the concept tags).')
                      : (isRename
                        ? 'Renaming is safe (planners link a subject by ID, not name) — just confirm it’s intended.'
                        : 'Delete will be blocked while it’s still linked. First repoint/remove it in these planners, or use Merge to move everything into another subject.')}
                  </p>
                </div>
              ) : (
                <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">Not used in any planner yet — safe to {isRename ? 'rename' : 'delete'}.</div>
              )}

              {isRename && (
                <input autoFocus value={pending.value} onChange={(e) => setPending((p) => (p && 'value' in p ? { ...p, value: e.target.value } : p))} className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}

              <div className="flex gap-2">
                <button onClick={confirmPending} disabled={pendingBusy} className={`h-10 px-4 text-white rounded-lg text-sm font-medium disabled:opacity-50 ${isRename ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'}`}>{pendingBusy ? 'Working…' : isRename ? 'Save change' : mapped ? 'Delete anyway' : 'Delete'}</button>
                <button onClick={() => setPending(null)} disabled={pendingBusy} className="h-10 px-4 border border-gray-300 rounded-lg text-sm font-medium text-gray-700">Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}

      {mergeSubj && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setMergeSubj(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-gray-200 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-900 mb-1">Merge subject</h3>
            <p className="text-sm text-gray-500 mb-4">Move everything from <span className="font-semibold">{mergeSubj.name}</span> into another subject — its chapters, and any faculty/batch/planner/test links, get re-pointed, then <span className="font-semibold">{mergeSubj.name}</span> is deleted. Nothing breaks.</p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Merge into</label>
            <select value={mergeSubjTarget} onChange={(e) => setMergeSubjTarget(e.target.value)} className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-violet-500">
              <option value="">Select the subject to keep</option>
              {subjects.filter((s) => s.id !== mergeSubj.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <div className="flex gap-2">
              <button onClick={handleMergeSubject} disabled={!mergeSubjTarget || mergingSubj} className="h-10 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white rounded-lg text-sm font-medium">{mergingSubj ? 'Merging…' : 'Merge'}</button>
              <button onClick={() => setMergeSubj(null)} className="h-10 px-4 border border-gray-300 rounded-lg text-sm font-medium text-gray-700">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {libOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setLibOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-gray-200 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <h3 className="font-semibold text-gray-900">Add subjects from library</h3>
                <p className="text-xs text-gray-500">Pick subjects — their chapters come along automatically. Copies into this program (existing ones are skipped).</p>
              </div>
              <button onClick={() => setLibOpen(false)} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-gray-100 text-gray-400">✕</button>
            </div>
            <div className="p-4 border-b border-gray-100">
              <input value={libSearch} onChange={(e) => setLibSearch(e.target.value)} placeholder="Search subjects…" className="w-full h-9 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {libLoading ? (
                <p className="text-sm text-gray-400 text-center py-6">Loading library…</p>
              ) : library.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">Library is empty — import a syllabus first.</p>
              ) : (
                <div className="space-y-1.5">
                  {library.filter((l) => l.name.toLowerCase().includes(libSearch.toLowerCase())).map((l) => {
                    const sel = libSel.has(l.name)
                    return (
                      <label key={l.name} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer ${sel ? 'bg-violet-50 border-violet-300' : 'bg-gray-50 border-gray-200 hover:border-violet-200'}`}>
                        <input type="checkbox" checked={sel} onChange={() => setLibSel((prev) => { const n = new Set(prev); n.has(l.name) ? n.delete(l.name) : n.add(l.name); return n })} className="mt-1" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{l.name} <span className="text-xs text-gray-400">· {l.chapters.length} chapters</span></div>
                          {l.chapters.length > 0 && <div className="text-[11px] text-gray-500 truncate">{l.chapters.join(', ')}</div>}
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-500">{libSel.size} selected</span>
              <div className="flex gap-2">
                <button onClick={() => setLibOpen(false)} className="h-10 px-4 border border-gray-300 rounded-lg text-sm font-medium text-gray-700">Cancel</button>
                <button onClick={addFromLibrary} disabled={libSel.size === 0 || libBusy} className="h-10 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white rounded-lg text-sm font-medium">{libBusy ? 'Adding…' : `Add ${libSel.size || ''} to program`}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
