import { opendir, stat } from 'node:fs/promises';
import { projectReadPath } from './project-read-path.js';
import { readProjectFile } from './project-file-read.js';

const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.mcp-indexer', '.cache', '.turbo', 'coverage']);
const sourceFile = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|kt|swift|rb|php|[ch]|cpp|hpp)$/i;
const identifier = /[\p{L}\p{N}_$]/u;
export interface DiskReference { file_path: string; line: number; context: string; context_truncated: boolean; context_characters: number }
export interface DiskReferenceCursor { file_offset: number; line_offset: number }
export interface DiskReferences {
  references: DiskReference[]; observedMatches: number; complete: boolean; scannedFiles: number;
  skippedFiles: number; warnings: string[]; next?: DiskReferenceCursor;
}

function containsName(line: string, name: string): boolean {
  let offset = 0;
  while (true) {
    const at = line.indexOf(name, offset); if (at < 0) return false;
    if ((!at || !identifier.test(line[at - 1])) && (at + name.length >= line.length || !identifier.test(line[at + name.length]))) return true;
    offset = at + Math.max(1, name.length);
  }
}

/** Async handles, bounded bytes/results/time and an explicit file/line cursor.
 * Filesystem order may change; callers should restart after file-tree edits. */
export async function diskReferences(root: string, name: string, searchPath: string, limit: number,
  cursor: DiskReferenceCursor, signal?: AbortSignal): Promise<DiskReferences> {
  signal?.throwIfAborted();
  const references: DiskReference[] = [], warnings: string[] = [];
  const deadline = performance.now() + 2000;
  let fileIndex = 0, scannedFiles = 0, skippedFiles = 0, bytes = 0, complete = true, lookahead = false, next: DiskReferenceCursor | undefined;
  const warn = (message: string) => { complete = false; if (warnings.length < 10) warnings.push(message); };
  async function* files(path: string, depth: number): AsyncGenerator<string> {
    signal?.throwIfAborted();
    if (performance.now() > deadline) { warn('Disk enumeration time budget reached; narrow search_path if the cursor cannot advance.'); return; }
    if (depth > 20) { warn(`Directory depth budget reached at ${path}`); return; }
    const canonical = await projectReadPath(root, path, signal), info = await stat(canonical); signal?.throwIfAborted();
    if (info.isFile()) { if (sourceFile.test(path)) yield path; return; }
    if (!info.isDirectory()) return;
    const handle = await opendir(canonical, { bufferSize: 32 });
    try {
      while (true) {
        signal?.throwIfAborted();
        if (performance.now() > deadline) { warn('Disk enumeration time budget reached; narrow search_path if the cursor cannot advance.'); return; }
        const entry = await handle.read(); if (!entry) break;
        if (ignored.has(entry.name) || entry.name.startsWith('.') || (!entry.isFile() && !entry.isDirectory())) continue;
        const child = path ? path + '/' + entry.name : entry.name;
        try { if (entry.isDirectory()) yield* files(child, depth + 1); else if (sourceFile.test(child)) yield child; }
        catch (error) { signal?.throwIfAborted(); skippedFiles++; warn(`Skipped unreadable path: ${child}`); }
      }
    } finally { await handle.close(); }
  }
  for await (const path of files(searchPath, 0)) {
    signal?.throwIfAborted();
    const current = fileIndex++;
    if (current < cursor.file_offset) continue;
    if (scannedFiles >= 100 || bytes >= 8 * 1024 * 1024 || performance.now() > deadline) {
      next = { file_offset: current, line_offset: 0 }; warn('Disk page budget reached.'); break;
    }
    scannedFiles++;
    try {
      const read = await readProjectFile(root, path, signal, { offset: 0, limit: 1024 * 1024 + 4, encoding: 'utf8' });
      bytes += read.retainedBytes;
      if (read.totalBytes > 1024 * 1024) { skippedFiles++; warn(`File exceeds 1 MiB: ${path}; use read_file byte pages.`); continue; }
      const lines = read.content.split('\n');
      const start = current === cursor.file_offset ? cursor.line_offset : 0;
      for (let line = start; line < lines.length; line++) {
        if (line % 128 === 0) {
          signal?.throwIfAborted();
          if (performance.now() > deadline) { next = { file_offset: current, line_offset: line }; warn('Disk matching time budget reached.'); break; }
        }
        if (!containsName(lines[line], name)) continue;
        if (references.length === limit) { next = { file_offset: current, line_offset: line }; complete = false; lookahead = true; break; }
        const context = lines[line].trim();
        let characters = 0, snippet = '';
        for (const character of context) { if (characters++ < 1024) snippet += character; }
        references.push({ file_path: path, line: line + 1, context: snippet, context_truncated: characters > 1024, context_characters: characters });
      }
      if (next) break;
    } catch (error) { signal?.throwIfAborted(); skippedFiles++; warn(`Skipped unreadable or changed file: ${path}`); }
  }
  signal?.throwIfAborted();
  return { references, observedMatches: references.length + Number(lookahead),
    complete, scannedFiles, skippedFiles, warnings, ...(next ? { next } : {}) };
}
