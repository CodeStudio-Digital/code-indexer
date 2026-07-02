/**
 * Index-backed "go to implementation" fallback — for languages without a TS
 * service or a ready LSP server (or when the server answers nothing). The
 * structural index records inheritance edges (implements/extends), so the
 * word under the cursor is looked up as an interface (implementors) AND as a
 * base class (subclasses). Name-based like the other fallbacks — honest
 * middle ground, not scope-resolved.
 *
 * Pure: content is passed in (the router reads live buffer/disk), the db is
 * only touched through two lookups — trivially fakeable in tests, no sqlite.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LspLocation } from '@mcp/api-bus';
import type { DBSymbol } from '@mcp/shared/types.js';
import { wordAt } from './index-fallback.js';

/** Same absolute-path idiom as index-fallback's fallbackDefinition — the
 *  definition contract carries absolute canonical paths for `monaco.Uri.file`. */
function absPath(root: string, rel: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${rel.replace(/\\/g, '/')}`;
}

function toLocation(root: string, s: DBSymbol): LspLocation {
  const line = s.line ?? 1;
  const col = s.col ?? 1;
  return {
    file: absPath(root, s.file_path),
    range: { start: { line, column: col }, end: { line, column: col + s.name.length } },
  };
}

export function fallbackImplementation(
  db: Pick<CodeIndexDB, 'getImplementors' | 'getSubclasses'>,
  projectId: number,
  root: string,
  content: string,
  position: { line: number; column: number },
): LspLocation[] {
  const word = wordAt(content, position.line, position.column);
  if (!word) return [];
  const seen = new Set<string>();
  const out: LspLocation[] = [];
  for (const s of [...db.getImplementors(projectId, word), ...db.getSubclasses(projectId, word)]) {
    const key = `${s.file_path}:${s.line ?? 0}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toLocation(root, s));
  }
  return out.slice(0, 50);
}
