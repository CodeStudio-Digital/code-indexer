import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { IndexToolContext } from '../../context.js';
import { findReferences } from '../symbol-references.js';
import { diskReferences } from '../symbol-disk-search.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symbol-reference-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('refs-project', root), other = db.createProject('other', root + '-other');
  const add = (path: string, count: number, projectId = project.id) => {
    const id = db.upsertFile(projectId, { path, language: 'typescript', size: 1, lineCount: count, contentHash: 'fixture' });
    db.upsertSymbolReferences(projectId, id, path, Array.from({ length: count }, (_, i) => ({ symbol_name: 'target', kind: 'call', line: i + 1, snippet: `target();${i}` })));
  };
  const ctx = { db } as IndexToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await findReferences.handler({ project_name: project.name, symbol_name: 'target', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, other, add, ctx, read };
}

it('pages exact indexed counts, returns metadata only, and never falls back at an out-of-range index offset', async () => {
  const { add, read, other, db } = fixture(); add('a.ts', 553); add('secret.ts', 1, other.id);
  vi.spyOn(db, 'getSymbolCallers').mockImplementation(() => { throw new Error('full references'); });
  vi.spyOn(db, 'findSymbolsByName').mockImplementation(() => { throw new Error('full definitions'); });
  const first = await read({ limit: 500 }); expect(first.value).toMatchObject({ total: 553, total_exact: true, next_offset: 500, source: 'db' });
  expect(first.result).toMatchObject({ sourceTruncations: [{ inputSize: 553, outputSize: 500 }] });
  const tail = (await read({ offset: 500 })).value; expect(tail.references).toHaveLength(50); expect(tail.next_offset).toBe(550);
  expect((await read({ offset: 550 })).value.references).toHaveLength(3);
  const beyond = (await read({ offset: 999 })).value; expect(beyond).toMatchObject({ source: 'db', total: 553, recovery: { offset: 0 } });
});

it('honestly reports name-based resolution and verifies a supplied definition without silently changing files', async () => {
  const { root, read, add } = fixture(); add('callers.ts', 1);
  writeFileSync(join(root, 'definition.ts'), 'export function target() {}'); writeFileSync(join(root, 'wrong.ts'), 'export function nope() { target(); }');
  const valid = (await read({ file_path: 'definition.ts' })).value;
  expect(valid.note).toContain('file_path verifies the definition only'); expect(valid.references[0].file_path).toBe('callers.ts');
  await expect(read({ file_path: 'wrong.ts' })).rejects.toThrow('SYMBOL_NOT_FOUND');
  await expect(read({ search_path: '../secret' })).rejects.toThrow('outside');
});

it('recovers every disk hit across file/line cursors without regexp execution or duplicate matches', async () => {
  const { root, read } = fixture(); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'calls.ts'), Array.from({ length: 60 }, (_, i) => `target(); // ${i}`).join('\n'));
  const first = await read({ limit: 50 });
  expect(first.value).toMatchObject({ source: 'disk_grep_fallback', total_at_least: 51, total_exact: false, recovery: { scan_file_offset: 0, scan_line_offset: 50 } });
  const tail = (await read({ ...first.value.recovery })).value;
  expect(tail.references).toHaveLength(10); expect(tail.total).toBeUndefined(); expect(tail.total_exact).toBe(false);
  expect(new Set([...first.value.references, ...tail.references].map(r => `${r.file_path}:${r.line}`)).size).toBe(60);
  writeFileSync(join(root, 'literal.ts'), 'target$();\ntarget();\nsupertarget$();');
  const dollar = (await read({ symbol_name: 'target$', search_path: 'literal.ts', source: 'disk' })).value;
  expect(dollar.references.map((r: { line: number }) => r.line)).toEqual([1]);
});

it('bounds disk files and bytes, reports incomplete scans, skips symlinks and closes handles on cancellation', async () => {
  const { root, read } = fixture(); mkdirSync(join(root, 'many'));
  for (let i = 0; i < 102; i++) writeFileSync(join(root, 'many', `f${String(i).padStart(3, '0')}.ts`), 'export const empty = 1;');
  const page = (await read({ search_path: 'many' })).value;
  expect(page).toMatchObject({ total_exact: false, scanned_files: 100, recovery: { scan_file_offset: 100 } });
  expect((await read({ ...page.recovery })).value.scanned_files).toBe(2);
  writeFileSync(join(root, 'large.ts'), 'target();' + 'x'.repeat(1024 * 1024));
  const large = (await read({ search_path: 'large.ts' })).value;
  expect(large).toMatchObject({ skipped_files: 1, total_exact: false }); expect(large.warnings[0]).toContain('1 MiB');
  const outside = mkdtempSync(join(tmpdir(), 'refs-outside-')); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.ts'), 'target();'); const link = join(root, 'external'); symlinkSync(outside, link, 'junction'); cleanup.push(() => unlinkSync(link));
  await expect(read({ search_path: 'external' })).rejects.toThrow('outside');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('stopped')), 5);
  try { await expect(diskReferences(root, 'missing', 'many', 50, { file_offset: 0, line_offset: 0 }, controller.signal)).rejects.toThrow('stopped'); }
  finally { clearTimeout(timer); }
});

it('clips only context snippets, signals clipping, and orders preparation callers by path proximity in SQL', () => {
  const { db, add, project } = fixture(); add('z/target.ts', 1); add('z/peer.ts', 1); add('a/other.ts', 1); add('z/deeper/child.ts', 1);
  const page = db.listAgentSymbolReferences(project.id, 'target', { offset: 0, limit: 4, targetFile: 'z/target.ts' });
  expect(page.items.map(r => r.file_path)).toEqual(['z/target.ts', 'z/peer.ts', 'a/other.ts', 'z/deeper/child.ts']);
  const id = db.upsertFile(project.id, { path: 'long.ts', language: 'typescript', size: 2000, lineCount: 1, contentHash: 'fixture' });
  db.upsertSymbolReferences(project.id, id, 'long.ts', [{ symbol_name: 'long', kind: 'call', line: 1, snippet: 'x'.repeat(2000) }]);
  const clipped = db.listAgentSymbolReferences(project.id, 'long', { offset: 0, limit: 1 }).items[0];
  expect(clipped.context).toHaveLength(1024); expect(clipped.context_truncated).toBe(1);
});
