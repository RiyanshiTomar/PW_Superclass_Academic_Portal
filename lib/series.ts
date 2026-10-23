// A test series = the papers sharing one name, e.g. every "Milestone Test - 01"
// paper. Names are typed by hand, so spacing, "-", leading zeros, "test" and
// the common misspellings ("Miletone", "Mlestone") don't split a series.
const ACRONYMS = new Set(['ca', 'cuet', 'ipmat', 'clat', 'ailet', 'caf'])
export const seriesOf = (name: string): { key: string; label: string } => {
  const words = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((w) => (/^(miletone|mlestone|milstone|milestne)$/.test(w) ? 'milestone' : /^\d+$/.test(w) ? String(Number(w)) : w))
    .filter((w) => w !== 'test')
  const key = words.join(' ')
  const num = /^\d+$/.test(words[words.length - 1] ?? '') ? words[words.length - 1] : null
  const fam = (num ? words.slice(0, -1) : words).map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  return { key, label: `${fam.join(' ')} Test${num ? ` ${num}` : ''}`.trim() }
}
