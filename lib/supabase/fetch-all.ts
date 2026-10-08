// ============================================================
// Two PostgREST limits silently break big reads:
//  1. A select returns at most 1000 rows — the rest are just missing.
//  2. `.in(col, ids)` puts every id in the URL; a few hundred UUIDs make the
//     URL too long and the request fails with "Bad Request" (empty data).
// These helpers page past (1) and chunk past (2). Use them for any read that
// can grow with the data (tests, chapters, results, lectures, audits).
// ============================================================

type PgError = { message: string } | null
type PageResult<T> = PromiseLike<{ data: T[] | null; error: PgError }>

const PAGE = 1000
const CHUNK = 150

/** Every row of a select, paging 1000 at a time. `build(from, to)` must apply
 *  `.range(from, to)` (and ideally a stable `.order`). */
export async function fetchAll<T>(build: (from: number, to: number) => PageResult<T>): Promise<{ data: T[]; error: string | null }> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) return { data: out, error: error.message }
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return { data: out, error: null }
}

/** Every row matching `col IN ids`, for any number of ids: ids are chunked so
 *  the URL stays short, and each chunk is paged. `build(chunk, from, to)` must
 *  apply `.in(col, chunk)` and `.range(from, to)`. */
export async function fetchAllIn<T>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PageResult<T>
): Promise<{ data: T[]; error: string | null }> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  const out: T[] = []
  let firstError: string | null = null
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK))
  const results = await Promise.all(chunks.map((chunk) => fetchAll<T>((from, to) => build(chunk, from, to))))
  for (const r of results) {
    out.push(...r.data)
    if (r.error && !firstError) firstError = r.error
  }
  return { data: out, error: firstError }
}
