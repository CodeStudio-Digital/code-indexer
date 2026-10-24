import { createHash } from 'node:crypto';

/** Cursors are tied to the visible catalog. A changed catalog restarts at page
 * one instead of silently shifting or exposing another profile's entries. */
export function resourcePage<T extends { uri?: string; uriTemplate?: string }>(items: T[], kind: string, cursor?: string): { items: T[]; nextCursor?: string } {
  const sorted = [...items].sort((a, b) => (a.uri ?? a.uriTemplate ?? '').localeCompare(b.uri ?? b.uriTemplate ?? ''));
  const revision = createHash('sha256').update(kind).update(JSON.stringify(sorted)).digest('hex');
  let offset = 0;
  if (cursor != null) {
    if (cursor.length > 256) throw new Error('Invalid resource cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid resource cursor'); }
    if (!parsed || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > sorted.length) throw new Error('Invalid resource cursor');
    if (parsed.revision !== revision) throw new Error('Resource catalog changed; list again without a cursor');
    offset = parsed.offset;
  }
  const page = sorted.slice(offset, offset + 100);
  return { items: page, ...(offset + page.length < sorted.length
    ? { nextCursor: Buffer.from(JSON.stringify({ revision, offset: offset + page.length })).toString('base64url') } : {}) };
}
