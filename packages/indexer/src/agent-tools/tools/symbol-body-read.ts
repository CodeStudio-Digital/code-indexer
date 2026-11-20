import { readProjectFile } from './project-file-read.js';
import { boundedTextOperation } from './bounded-pattern.js';
import { extractSymbolBodyFromContent, findSymbolDeclLineFromContent } from '@mcp/services/services/code-reader.js';
import { treeSitterSymbols } from '@mcp/indexer/indexer/incremental.js';
import type { CodeIndexDB } from '@mcp/store/db.js';

/** Locate in a bounded index-file page when a newly added declaration has not
 * reached the symbol index. Recovery advances files, never silently rescans all. */
export async function locateCurrentSymbol(db: CodeIndexDB, projectId: number, root: string, name: string, offset: number, signal?: AbortSignal): Promise<{
  path?: string; inspected: number; skipped: number; total: number; nextOffset?: number;
}> {
  const page = db.listAgentIndexFiles(projectId, { offset, limit: 100 });
  const deadline = performance.now() + 1000; let bytes = 0, inspected = 0, skipped = 0;
  for (const file of page.items) {
    signal?.throwIfAborted();
    if (performance.now() > deadline || bytes >= 8 * 1024 * 1024) break;
    inspected++;
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|kt|swift|rb|php|[ch]|cpp|hpp)$/i.test(file.path)) continue;
    try {
      const read = await readProjectFile(root, file.path, signal, { offset: 0, limit: 1024 * 1024 + 4, encoding: 'utf8' });
      bytes += read.retainedBytes;
      if (read.totalBytes > 1024 * 1024) { skipped++; continue; }
      const line = boundedTextOperation(() => findSymbolDeclLineFromContent(read.content, name), signal);
      if (line != null) return { path: file.path, inspected, skipped, total: page.total };
    } catch (error) {
      signal?.throwIfAborted();
      // Unreadable/stale/oversized files are explicitly reported as incomplete.
      skipped++;
    }
  }
  return { inspected, skipped, total: page.total, ...(offset + inspected < page.total ? { nextOffset: offset + inspected } : {}) };
}

/** Parse current bytes before trusting indexed line/end_line. A heuristic range
 * is labelled as such and always offers a read_file continuation. */
export async function currentSymbolBody(root: string, path: string, name: string, declarationLine: number | undefined, signal?: AbortSignal) {
  const read = await readProjectFile(root, path, signal);
  const parsed = read.totalBytes <= 1024 * 1024 ? await treeSitterSymbols(path, read.content, { signal }) : null;
  const matches = parsed?.symbols.filter(s => s.name === name && (declarationLine == null || s.line === declarationLine)) ?? [];
  if (matches.length > 1) return { ambiguous: true as const, candidates: matches.map(s => ({ file_path: path, line: s.line, kind: s.kind, parent: s.parent })) };
  const selected = matches[0];
  if (parsed && !selected) throw new Error(`[SYMBOL_NOT_FOUND] Current parsed declarations do not contain "${name}" at the requested location in "${path}". Use get_file_skeleton to refresh the location.`);
  const line = selected?.line ?? boundedTextOperation(() => findSymbolDeclLineFromContent(read.content, name), signal);
  if (line == null || (declarationLine != null && line !== declarationLine)) throw new Error(`[SYMBOL_NOT_FOUND] Symbol "${name}" not found at the requested declaration in "${path}". Use get_file_skeleton to refresh the location.`);
  const lines = read.content.split('\n');
  const exact = selected != null && typeof selected.end_line === 'number' && selected.end_line >= line;
  const end = exact ? selected.end_line! : boundedTextOperation(() => extractSymbolBodyFromContent(path, read.content, line).end_line, signal);
  signal?.throwIfAborted();
  return { ambiguous: false as const, lines, start: line, end, rangeKind: exact ? 'parsed' as const : 'heuristic' as const };
}
