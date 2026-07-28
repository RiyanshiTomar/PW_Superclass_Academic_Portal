'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Alert, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'

type Program = { id: string; name: string }
type Subject = { id: string; name: string; program_id: string }
type Chapter = { id: string; subject_id: string; name: string; total_hours: number | null; teaching_hours: number | null; sequence_no: number }
type Topic = { id: string; chapter_id: string; name: string }

const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const fmtH = (n: number | null) => (n == null ? '' : String(n))

// Fetch every row of a table (paginated — concept tags can exceed the 1000 cap).
async function fetchAll<T>(query: (from: number) => Promise<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await query(from)
    if (error || !data) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

export default function ConceptTagsView() {
  const supabase = createClient()
  const [programs, setPrograms] = useState<Program[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [programId, setProgramId] = useState('')
  const [search, setSearch] = useState('')
  const [openSub, setOpenSub] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const [progRes, subRes] = await Promise.all([
        supabase.from('programs').select('id, name').order('name'),
        supabase.from('subjects').select('id, name, program_id').order('name'),
      ])
      setPrograms((progRes.data ?? []) as Program[])
      setSubjects((subRes.data ?? []) as Subject[])
      // Chapters (with hours if the column exists), paginated.
      let chaps = await fetchAll<Chapter>((from) => supabase.from('chapters').select('id, subject_id, name, total_hours, teaching_hours, sequence_no').order('sequence_no').range(from, from + 999) as unknown as Promise<{ data: Chapter[] | null; error: unknown }>)
      if (chaps.length === 0) {
        chaps = await fetchAll<Chapter>((from) => supabase.from('chapters').select('id, subject_id, name, sequence_no').order('sequence_no').range(from, from + 999) as unknown as Promise<{ data: Chapter[] | null; error: unknown }>)
      }
      setChapters(chaps)
      const tops = await fetchAll<Topic>((from) => supabase.from('topics').select('id, chapter_id, name').range(from, from + 999) as unknown as Promise<{ data: Topic[] | null; error: unknown }>)
      setTopics(tops)
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const progName = useMemo(() => new Map(programs.map((p) => [p.id, p.name])), [programs])
  const chaptersOf = (sid: string) => chapters.filter((c) => c.subject_id === sid)
  const topicsOf = (cid: string) => topics.filter((t) => t.chapter_id === cid)

  const shownSubjects = useMemo(() => {
    const q = search.toLowerCase().trim()
    return subjects
      .filter((s) => (!programId || s.program_id === programId) && (!q || s.name.toLowerCase().includes(q)))
      .sort((a, b) => (progName.get(a.program_id) || '').localeCompare(progName.get(b.program_id) || '') || a.name.localeCompare(b.name))
  }, [subjects, programId, search, progName])

  const totals = useMemo(() => {
    const subs = programId ? subjects.filter((s) => s.program_id === programId) : subjects
    const subIds = new Set(subs.map((s) => s.id))
    const chs = chapters.filter((c) => subIds.has(c.subject_id))
    const chIds = new Set(chs.map((c) => c.id))
    const tps = topics.filter((t) => chIds.has(t.chapter_id))
    return { subjects: subs.length, chapters: chs.length, topics: tps.length }
  }, [subjects, chapters, topics, programId])

  const downloadCsv = () => {
    // One row per chapter: Course, Subject, Chapter, Total Hours, Teaching Hours, Topics.
    const header = ['Course', 'Subject', 'Chapter', 'Total Hours', 'Teaching Hours', 'Topics']
    const lines = [header.join(',')]
    const subs = shownSubjects
    for (const s of subs) {
      const chs = chaptersOf(s.id)
      if (chs.length === 0) {
        lines.push([progName.get(s.program_id) || '', s.name, '', '', '', ''].map(csvCell).join(','))
        continue
      }
      for (const c of chs) {
        const tps = topicsOf(c.id).map((t) => t.name).join('; ')
        lines.push([progName.get(s.program_id) || '', s.name, c.name, fmtH(c.total_hours), fmtH(c.teaching_hours), tps].map(csvCell).join(','))
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `concept-tags${programId ? '-' + (progName.get(programId) || '').replace(/\s+/g, '_') : ''}.csv`
    a.click(); URL.revokeObjectURL(url)
    setMsg('CSV downloaded.')
  }

  const toggle = (sid: string) => setOpenSub((prev) => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n })

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="Concept Tags" description="The master syllabus — Program → Subject → Chapter → Topic (with hours). Read-only here; download it as CSV. Only Admin can edit the tags." />

      {msg && <Alert type="success">{msg}</Alert>}

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Search subject</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a subject name…" className="w-full h-11 px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Program</label>
          <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="h-11 min-w-[200px] px-3 bg-white border border-neutral-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
            <option value="">All programs</option>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <BtnSecondary onClick={downloadCsv} disabled={loading || shownSubjects.length === 0}>Download CSV</BtnSecondary>
      </div>

      {!loading && <p className="text-xs text-neutral-400 mb-3">{totals.subjects} subjects · {totals.chapters} chapters · {totals.topics} topics{programId ? '' : ' (all programs)'}</p>}

      {loading ? (
        <Card className="p-10 text-center text-neutral-400">Loading concept tags…</Card>
      ) : shownSubjects.length === 0 ? (
        <Card className="p-10 text-center text-neutral-500">No subjects match.</Card>
      ) : (
        <div className="space-y-3">
          {shownSubjects.map((s) => {
            const chs = chaptersOf(s.id)
            const open = openSub.has(s.id)
            return (
              <Card key={s.id} className="p-0 overflow-hidden">
                <button onClick={() => toggle(s.id)} className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-neutral-50 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-400 text-xs w-3">{open ? '▾' : '▸'}</span>
                    <span className="font-semibold text-neutral-950">{s.name}</span>
                    <span className="text-[11px] text-neutral-400">{progName.get(s.program_id)}</span>
                  </div>
                  <span className="text-xs text-neutral-400">{chs.length} chapters</span>
                </button>
                {open && (
                  <div className="border-t border-neutral-100 divide-y divide-neutral-100">
                    {chs.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-neutral-400">No chapters.</p>
                    ) : chs.map((c) => {
                      const tps = topicsOf(c.id)
                      return (
                        <div key={c.id} className="px-4 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-neutral-800">{c.name}</span>
                            <span className="text-[11px] text-neutral-500 whitespace-nowrap">
                              {c.total_hours != null && <span className="mr-2">Total {c.total_hours}h</span>}
                              {c.teaching_hours != null && <span className="mr-2">Teaching {c.teaching_hours}h</span>}
                              {tps.length} topics
                            </span>
                          </div>
                          {tps.length > 0 && <p className="text-[11px] text-neutral-500 mt-1">{tps.map((t) => t.name).join(' · ')}</p>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
