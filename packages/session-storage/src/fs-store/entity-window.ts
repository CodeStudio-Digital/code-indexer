/** Keep only the requested ordered window while the source performs bounded I/O.
 * This bounds hydrated memory; it is not an on-disk index and still scans files. */
export async function entityWindow<T>(source: AsyncIterable<T>, options: {
  limit: number; offset?: number; compare(a: T, b: T): number; filter?(item: T): boolean;
}): Promise<T[]> {
  const { limit, offset = 0, compare, filter } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new Error('Invalid entity window');
  const rows: T[] = [], capacity = limit + offset;
  for await (const row of source) {
    if (filter && !filter(row)) continue;
    if (rows.length === capacity && compare(row, rows[capacity - 1]) >= 0) continue;
    let low = 0, high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(row, rows[mid]) >= 0) low = mid + 1; else high = mid;
    }
    rows.splice(low, 0, row);
    if (rows.length > capacity) rows.pop();
  }
  return rows.slice(offset);
}
