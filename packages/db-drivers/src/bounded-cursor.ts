import type { RunQueryOptions } from './types.js';
import { assertDatabaseDispatch } from './dispatch.js';

export interface DatabaseCursor<T> extends AsyncIterable<T> { close(): Promise<void> }

/** Do not materialize an entire collection to display a single result page. */
export async function readCursorWindow<T>(cursor: DatabaseCursor<T>, max: number,
  options: RunQueryOptions, drain = false): Promise<{ rows: T[]; rowCount: number; truncated: boolean }> {
  const rows: T[] = [];
  let rowCount = 0, closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(() => cursor.close());
  const onAbort = () => { void close().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const iterator = cursor[Symbol.asyncIterator]();
    for (;;) {
      assertDatabaseDispatch(options);
      const item = await iterator.next();
      options.signal?.throwIfAborted();
      if (item.done) break;
      rowCount++;
      if (rows.length < max) rows.push(item.value);
      if (!drain && rowCount > max) break;
    }
    return { rows, rowCount, truncated: rowCount > max };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await close();
  }
}
