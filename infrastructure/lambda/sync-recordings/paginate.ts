// PostgREST silently truncates any request — including explicit .range()
// calls — at the server's max-rows setting (Supabase default: 1000). A
// single .range(0, 49999) therefore caps out at 1000 rows, and a truncated
// exclusion set re-admits already-synced or permanently-failed games into
// the sync queue. Page instead, advancing by rows actually received so a
// server cap smaller than our page size can never skip rows.

const PAGE_SIZE = 1000

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  opts: { cap: number; label: string }
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  while (true) {
    const batch = await fetchPage(from, from + PAGE_SIZE - 1)
    all.push(...batch)
    if (batch.length === 0) return all
    from += batch.length
    if (from >= opts.cap) {
      // Hard-stop instead of silently truncating. When this fires, switch
      // to keyset pagination (or aggressive cleanup) rather than raising
      // the cap.
      throw new Error(
        `fetchAllRows: '${opts.label}' hit the ${opts.cap}-row cap — paginate by keyset before more rows are silently excluded`
      )
    }
  }
}
