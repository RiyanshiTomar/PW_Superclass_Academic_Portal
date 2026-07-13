'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseCSVWithHeaders } from '@/lib/utils'
import { mergeSubject } from '@/lib/merge'

type Program = { id: string; name: string }
type Subject = { id: string; name: string }
type Chapter = { id: string; subject_id: string; name: string; sequence_no: number }
type Topic = { id: string; chapter_id: string; name: string; sequence_no: number }

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
    const { data: chaps } = await supabase.from('chapters').select('id, subject_id, name, sequence_no').in('subject_id', subIds).order('sequence_no')
    const chapters = (chaps ?? []) as Chapter[]
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
  const renameSubject = async (s: Subject) => {
    const name = prompt('Rename subject', s.name)?.trim()
    if (!name || name === s.name) return
    const { error } = await supabase.from('subjects').update({ name }).eq('id', s.id)
    if (error) return setMsg({ type: 'error', text: error.message })
    await loadProgram(programId)
  }
  const deleteSubject = async (s: Subject) => {
    if (!confirm(`Delete subject "${s.name}" with all its chapters & topics?`)) return
    const { error } = await supabase.from('subjects').delete().eq('id', s.id)
    if (error) return setMsg({ type: 'error', text: 'Cannot delete — subject may be used by a batch/planner.' })
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
  const renameChapter = async (c: Chapter) => {
    const name = prompt('Rename chapter', c.name)?.trim()
    if (!name || name === c.name) return
    const { error } = await supabase.from('chapters').update({ name }).eq('id', c.id)
    if (error) return setMsg({ type: 'error', text: error.message })
    await loadProgram(programId)
  }
  const deleteChapter = async (c: Chapter) => {
    if (!confirm(`Delete chapter "${c.name}" and its topics?`)) return
    await supabase.from('chapters').delete().eq('id', c.id)
    await loadProgram(programId)
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
                    <button onClick={() => renameSubject(s)} className="text-blue-600 hover:underline">Rename</button>
                    <button onClick={() => { setMergeSubj(s); setMergeSubjTarget(''); setMsg(null) }} className="text-violet-600 hover:underline">Merge</button>
                    <button onClick={() => deleteSubject(s)} className="text-red-600 hover:underline">Delete</button>
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
                            <div className="space-x-2 text-xs">
                              <button onClick={() => renameChapter(c)} className="text-blue-600 hover:underline">Rename</button>
                              <button onClick={() => deleteChapter(c)} className="text-red-600 hover:underline">Delete</button>
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
    </div>
  )
}
