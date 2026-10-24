import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { fileSkeleton } from '../file-skeleton.js';
import type { ToolContext } from '../../context.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import { TreeSitterExtractor } from '@mcp/indexer/indexer/tree-sitter/extractor.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skeleton-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('skeleton-project', root), other = db.createProject('other', root + '-other');
  const add = (path: string, projectId = project.id, count = 1) => {
    const id = db.upsertFile(projectId, { path, language: 'typescript', size: 1, lineCount: 1, contentHash: 'fixture' });
    const symbols = Array.from({ length: count }, (_, i) => ({ name: 'symbol-' + String(i).padStart(4, '0'), kind: 'function', signature: '()',
      parent: null, modifiers: [], return_type: null, parameters: null, line: i + 1, exported: true, comment: null, tags: [] } as LLMSymbol));
    db.upsertSymbols(projectId, id, path, symbols);
  };
  add('src/first.ts', project.id, 553); add('src/second.ts'); add('src-old/private.ts'); add('src/secret.ts', other.id);
  const ctx = { db } as ToolContext;
  const read = async (args: Record<string, unknown>) => {
    const result = await fileSkeleton.handler({ project_name: project.name, file_path: 'src', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, read, ctx };
}

it('counts all indexed declarations but materializes only a page without full file/symbol hydration', async () => {
  const { db, read } = fixture();
  vi.spyOn(db, 'listFiles').mockImplementation(() => { throw new Error('full files'); });
  vi.spyOn(db, 'getSymbolsByFile').mockImplementation(() => { throw new Error('full symbols'); });
  const first = await read({ max_symbols: 500 });
  expect(first.value).toMatchObject({ files_in_dir: 2, total_symbols: 554, shown_symbols: 500, next_offset: 500 });
  expect(first.result).toMatchObject({ sourceTruncations: [{ inputSize: 554, outputSize: 500, recoverable: true }] });
  const last = (await read({ offset: 500, max_symbols: 500 })).value;
  expect(last.shown_symbols).toBe(54); expect(last.next_offset).toBeUndefined();
  expect(last.files.map((f: { path: string }) => f.path)).toEqual(['src/first.ts', 'src/second.ts']);
  expect(JSON.stringify(last)).toContain('symbol-0552'); expect(JSON.stringify(last)).not.toContain('private');
});

it('pages an indexed file and applies name filters without pretending page counts are global filtered totals', async () => {
  const { read } = fixture();
  const first = (await read({ file_path: 'src/first.ts', filter: '0552$', max_symbols: 500 })).value;
  expect(first).toMatchObject({ total_candidates: 553, candidates_in_page: 500, matched_symbols_in_page: 0, next_offset: 500 });
  expect(first.total_symbols).toBeUndefined();
  const tail = (await read({ file_path: 'src/first.ts', filter: '0552$', offset: 500 })).value;
  expect(tail.symbols).toHaveLength(1); expect(tail.symbols[0].name).toBe('symbol-0552');
  expect((await read({ file_path: 'src/first.ts', kind: 'class' })).value.total_symbols).toBe(0);
});

it('bounds unindexed parsing, preserves fallback pages and rejects cancellation/path escapes', async () => {
  const { root, read, ctx } = fixture();
  writeFileSync(join(root, 'unindexed.ts'), Array.from({ length: 25 }, (_, n) => `export function f${n}() { return ${n}; }`).join('\n'));
  const first = (await read({ file_path: 'unindexed.ts', max_symbols: 5 })).value;
  expect(first).toMatchObject({ source: 'tree-sitter-fallback', total_symbols: 25, next_offset: 5 });
  expect((await read({ file_path: 'unindexed.ts', offset: 20, max_symbols: 5 })).value.symbols.map((s: { name: string }) => s.name))
    .toEqual(['f20', 'f21', 'f22', 'f23', 'f24']);
  writeFileSync(join(root, 'large.ts'), 'x'.repeat(1024 * 1024 + 1));
  await expect(read({ file_path: 'large.ts' })).rejects.toThrow('1 MiB');
  await expect(read({ file_path: '../escape.ts' })).rejects.toThrow('outside');
  await expect(fileSkeleton.handler({ project_name: 'skeleton-project', file_path: 'src' },
    { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
});

it('outline preserves declarations while avoiding dependency and call-graph extraction, and reuses its parser after abort', async () => {
  const extractor = new TreeSitterExtractor();
  try {
    const source = 'import {x} from "./dep"; export function a() { return x(); } export class B { call() { return a(); } }';
    const full = await extractor.extract('input.ts', source), outline = await extractor.outline('input.ts', source);
    expect(outline.analysis.symbols).toEqual(full.analysis.symbols); expect(outline.analysis.references).toBeUndefined();
    await expect(extractor.outline('input.ts', source, AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped');
    expect((await extractor.outline('next.ts', 'export const next = 1;')).analysis.symbols?.[0].name).toBe('next');
    const cold = new TreeSitterExtractor();
    try {
      const pair = await Promise.all(['alpha', 'beta'].map(name => cold.outline(name + '.ts', `export function ${name}() {}`)));
      expect(pair.map(p => p.analysis.symbols?.[0].name)).toEqual(['alpha', 'beta']);
    } finally { cold.dispose(); }
  } finally { extractor.dispose(); }
});
