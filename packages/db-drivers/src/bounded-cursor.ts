import type { RunQueryOptions } from './types.js';
import { assertDatabaseDispatch } from './dispatch.js';
import { ResultWindow } from './result-window.js';
import type { QueryResult } from './types.js';

export interface DatabaseCursor<T> extends AsyncIterable<T> { close(): Promise<void> }

export async function readDocumentWindow(cursor: DatabaseCursor<Record<string, unknown>>, max: number, options: RunQueryOptions,
  normalize: (row: Record<string, unknown>) => Record<string, unknown>, drain = false): Promise<Omit<QueryResult, 'fields'>> {
  const window = new ResultWindow(max);
  let complete = true;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= cursor.close();
  const abort = () => { void close().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const iterator = cursor[Symbol.asyncIterator]();
    for (;;) {
      assertDatabaseDispatch(options);
      const item = await iterator.next();
      options.signal?.throwIfAborted();
      if (item.done) break;
      window.push(window.observed < window.max && window.bytes < window.maxBytes ? normalize(item.value) : {});
      if (!drain && (window.observed > window.max || window.bytes >= window.maxBytes)) { complete = false; break; }
    }
    return { rows: window.rows, rowCount: window.observed, truncated: window.truncated || !complete,
      acquisition: { ...window.acquisition, mode: 'cursor', observedRowsExact: complete } };
  } finally { options.signal?.removeEventListener('abort', abort); await close(); }
}

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
