import { createHmac, randomBytes } from 'node:crypto';
import { ApiError, type DbCatalogSnapshot } from '@mcp/api-bus';
import type { DatabaseDriver, DbEngine } from '@mcp/db-drivers';
import { buildCatalogPage, type CatalogPageOptions } from '@mcp/db-drivers/sql/catalog-page.js';

const secret = randomBytes(32);
const sign = (text: string) => createHmac('sha256', secret).update(text).digest('base64url');
export async function readCatalogPage(driver: DatabaseDriver, engine: DbEngine, scope: string, opts: CatalogPageOptions & { cursor?: string }, signal?: AbortSignal): Promise<DbCatalogSnapshot> {
  signal?.throwIfAborted();
  let after: [string, string, string] | undefined;
  if (opts.cursor) {
    try {
      if (opts.cursor.length > 4096) throw new Error();
      const [text, signature] = opts.cursor.split('.');
      if (sign(text) !== signature) throw new Error();
      const value = JSON.parse(Buffer.from(text, 'base64url').toString());
      if (value.scope !== scope || value.expires < Date.now() || value.schema !== (opts.schema ?? '') || value.query !== (opts.query ?? '') || !Array.isArray(value.after) || value.after.length !== 3 || !value.after.every((s: unknown) => typeof s === 'string')) throw new Error();
      after = value.after;
    } catch { throw new ApiError('db_catalog_cursor_invalid', 409, 'Catalog cursor expired or scope changed. Restart this listing.'); }
  }
  const built = buildCatalogPage(engine, { ...opts, after });
  const result = await driver.runQuery(built.sql, { params: built.params, maxRows: built.limit + 1, signal, timeoutMs: 10_000 });
  const rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
  const objects = rows.slice(0, built.limit).map(row => ({ schema: String(row.schema_name), kind: String(row.object_kind) as 'table' | 'view' | 'function' | 'sequence', name: String(row.object_name) }));
  const complete = rows.length <= built.limit && !result.truncated;
  let nextCursor: string | undefined;
  if (!complete && objects.length) {
    const last = objects[objects.length - 1];
    const text = Buffer.from(JSON.stringify({ scope, schema: opts.schema ?? '', query: opts.query ?? '', after: [last.schema, last.kind, last.name], expires: Date.now() + 300_000 })).toString('base64url');
    nextCursor = `${text}.${sign(text)}`;
  }
  return { objects, refreshedAt: Date.now(), complete, nextCursor, consistency: 'best_effort', scope: opts.schema ?? null };
}
