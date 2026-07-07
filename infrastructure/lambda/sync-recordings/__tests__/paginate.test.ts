import { describe, it, expect, vi } from 'vitest'
import { fetchAllRows } from '../paginate'

function pagedSource(rows: number[], serverCap: number) {
  return vi.fn(async (from: number, to: number) => {
    const requested = to - from + 1
    return rows.slice(from, from + Math.min(requested, serverCap))
  })
}

describe('fetchAllRows', () => {
  it('returns everything when the result fits one page', async () => {
    const rows = Array.from({ length: 270 }, (_, i) => i)
    const fetchPage = pagedSource(rows, 1000)
    const result = await fetchAllRows(fetchPage, { cap: 49999, label: 'test' })
    expect(result).toEqual(rows)
  })

  it('pages through results larger than one page', async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => i)
    const fetchPage = pagedSource(rows, 1000)
    const result = await fetchAllRows(fetchPage, { cap: 49999, label: 'test' })
    expect(result).toEqual(rows)
  })

  it('survives a server max-rows smaller than the requested page size (the PostgREST 1000-row cap)', async () => {
    // Server silently truncates each page to 100 regardless of the range asked.
    const rows = Array.from({ length: 950 }, (_, i) => i)
    const fetchPage = pagedSource(rows, 100)
    const result = await fetchAllRows(fetchPage, { cap: 49999, label: 'test' })
    expect(result).toEqual(rows)
  })

  it('returns empty for an empty table', async () => {
    const fetchPage = pagedSource([], 1000)
    const result = await fetchAllRows(fetchPage, { cap: 49999, label: 'test' })
    expect(result).toEqual([])
  })

  it('throws loudly when the cap is hit instead of silently truncating', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => i)
    const fetchPage = pagedSource(rows, 1000)
    await expect(
      fetchAllRows(fetchPage, { cap: 2000, label: 'recordings' })
    ).rejects.toThrow(/recordings.*2000/)
  })
})
