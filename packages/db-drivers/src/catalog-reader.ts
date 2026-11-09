import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseDriver, DbEngine } from './types.js';
import { buildCatalogPage } from './sql/catalog-page.js';
import { withDatabaseDeadline } from './dispatch.js';

/** Cursor key belongs to this connection generation, never a global name. */
export function createCatalogReader(driver: DatabaseDriver, engine: DbEngine): NonNullable<DatabaseDriver['catalogPage']> {
  const key = randomBytes(32);
  const sign = (text: string) => createHmac('sha256', key).update(text).digest('base64url');
  return async options => {
    let after: [string, string, string] | undefined;
    if (options.cursor) {
      const [text, signature] = options.cursor.split('.');
      if (options.cursor.length > 4096 || !text || sign(text) !== signature) throw new Error('Catalog cursor does not belong to this connection generation');
      const state = JSON.parse(Buffer.from(text, 'base64url').toString());
      if (state.expires < Date.now() || state.schema !== (options.schema ?? '') || state.query !== (options.query ?? '')
        || !Array.isArray(state.after) || state.after.length !== 3 || !state.after.every((value: unknown) => typeof value === 'string')) throw new Error('Catalog cursor scope expired or changed');
      after = state.after;
    }
    const built = buildCatalogPage(engine, { ...options, after });
    const result = await withDatabaseDeadline({ params: built.params, maxRows: built.limit + 1, signal: options.signal, timeoutMs: 10_000 }, effective => driver.runQuery(built.sql, effective));
    const objects = result.rows.slice(0, built.limit).map(raw => {
      const row = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), value]));
      return { schema: String(row.schema_name), name: String(row.object_name), kind: String(row.object_kind) as 'table' | 'view' | 'function' | 'sequence' };
    });
    const complete = !result.truncated && result.rows.length <= built.limit;
    let nextCursor: string | undefined;
    if (!complete && objects.length) {
      const last = objects[objects.length - 1];
      const text = Buffer.from(JSON.stringify({ after: [last.schema, last.kind, last.name], schema: options.schema ?? '', query: options.query ?? '', expires: Date.now() + 300_000 })).toString('base64url');
      nextCursor = `${text}.${sign(text)}`;
    }
    return { objects, complete, nextCursor };
  };
}
