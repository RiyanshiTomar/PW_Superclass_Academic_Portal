// ============================================================
// Passing criteria by program (as given by the central team).
//  • CA Foundation / CA Intermediate (incl. Integrated 12th + CAF):
//      each paper ≥ 40%, and aggregate ≥ 50%.
//  • CLAT / CUET / IPMAT (incl. Integrated CUET+IPMAT): 50% of total marks.
//  • Commerce (11th / 12th): 40% in every subject.
// A pass mark typed on the test itself always wins over the rule.
// ============================================================

export type PassRule = {
  kind: 'CA' | 'ENTRANCE' | 'COMMERCE' | 'DEFAULT'
  label: string
  subjectPct: number | null   // every subject must reach this (null = not checked)
  aggregatePct: number | null // overall aggregate must reach this (null = not checked)
}

export function passRuleFor(programName: string | null | undefined): PassRule {
  const n = (programName ?? '').toLowerCase()
  if (/\bca\b|caf|cain|ca foundation|ca intermediate/.test(n))
    return { kind: 'CA', label: '40% in each paper and 50% aggregate', subjectPct: 40, aggregatePct: 50 }
  if (/clat|cuet|ipmat/.test(n))
    return { kind: 'ENTRANCE', label: '50% of total marks', subjectPct: null, aggregatePct: 50 }
  if (/commerce|11th|12th/.test(n))
    return { kind: 'COMMERCE', label: '40% in every subject', subjectPct: 40, aggregatePct: null }
  return { kind: 'DEFAULT', label: '40% of total marks', subjectPct: null, aggregatePct: 40 }
}

/** Pass % for ONE test: a single paper/subject (Part) or the whole syllabus (Full). */
export function testPassPct(rule: PassRule, partType: string | null | undefined): number {
  if (rule.kind === 'CA') return partType === 'Full' ? 50 : 40
  if (rule.kind === 'ENTRANCE') return 50
  return 40
}

/** Pass marks for a test: the test's own pass marks, else the program rule. */
export function passMarksFor(
  test: { max_marks: number | null; pass_marks: number | null; part_type?: string | null },
  rule: PassRule
): number | null {
  if (test.pass_marks != null) return test.pass_marks
  if (!test.max_marks) return null
  return Math.round(((test.max_marks * testPassPct(rule, test.part_type)) / 100) * 100) / 100
}

export type ScoreLine = { subjectId: string | null; obtained: number; max: number } // absent → obtained 0

/** Overall result of a student from their test lines (absent counted as 0). */
export function overallResult(lines: ScoreLine[], rule: PassRule, subjectName: (id: string) => string) {
  const sum = (ls: ScoreLine[]) => ls.reduce((a, l) => ({ o: a.o + l.obtained, m: a.m + l.max }), { o: 0, m: 0 })
  const all = sum(lines)
  const aggregate = all.m ? Math.round((all.o / all.m) * 1000) / 10 : null
  const bySubject = new Map<string, ScoreLine[]>()
  for (const l of lines) if (l.subjectId) bySubject.set(l.subjectId, [...(bySubject.get(l.subjectId) ?? []), l])
  const subjects = Array.from(bySubject.entries()).map(([id, ls]) => {
    const s = sum(ls)
    return { id, name: subjectName(id), pct: s.m ? Math.round((s.o / s.m) * 1000) / 10 : null }
  })
  if (aggregate == null) return { status: null as 'Pass' | 'Fail' | null, aggregate, subjects, reasons: [] as string[] }
  const reasons: string[] = []
  if (rule.subjectPct != null) {
    for (const s of subjects) if (s.pct != null && s.pct < rule.subjectPct) reasons.push(`${s.name} ${s.pct}% (< ${rule.subjectPct}%)`)
    // No subject-wise tests yet → judge the overall % against the subject bar.
    if (!subjects.length && aggregate < rule.subjectPct) reasons.push(`Overall ${aggregate}% (< ${rule.subjectPct}%)`)
  }
  if (rule.aggregatePct != null && aggregate < rule.aggregatePct) reasons.push(`Aggregate ${aggregate}% (< ${rule.aggregatePct}%)`)
  return { status: (reasons.length ? 'Fail' : 'Pass') as 'Pass' | 'Fail', aggregate, subjects, reasons }
}
