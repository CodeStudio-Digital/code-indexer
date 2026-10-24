import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import type { ToolContext } from '../../context.js';
import { getSymbolBody } from '../symbol-body.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symbol-body-current-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('body-project', root);
  const add = (path: string, text: string, symbols: Array<Partial<LLMSymbol> & { name: string }> = []) => {
    writeFileSync(join(root, path), text);
    const id = db.upsertFile(project.id, { path, language: 'typescript', size: text.length, lineCount: text.split('\n').length, contentHash: 'fixture' });
    db.upsertSymbols(project.id, id, path, symbols.map(s => ({ kind: 'function', signature: '()', parent: null, modifiers: [],
      return_type: null, parameters: null, line: 1, exported: true, comment: null, tags: [], ...s } as LLMSymbol)));
  };
  const ctx = { db } as ToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await getSymbolBody.handler({ project_name: project.name, symbol_name: 'target', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, add, ctx, read };
}

it('revalidates stale indexed positions and recovers every line of a long body', async () => {
  const { add, read, db } = fixture();
  add('body.ts', ['// shifted', '// shifted again', 'export function target() {', ...Array.from({ length: 900 }, (_, i) => `  console.log(${i});`), '}', 'export function unrelated() {}'].join('\n'),
    [{ name: 'target', line: 1, end_line: 2 }]);
  vi.spyOn(db, 'getSymbolsByFile').mockImplementation(() => { throw new Error('full hydration'); });
  const first = await read({ max_lines: 500 });
  expect(first.value).toMatchObject({ start_line: 3, end_line: 502, total_lines: 902, range_kind: 'parsed', next_line_offset: 500, used_fallback: true });
  expect(first.result).toMatchObject({ sourceTruncations: [{ inputSize: 902, outputSize: 500, inputSizeExact: true }] });
  const tail = (await read({ line_offset: 500 })).value;
  expect(tail).toMatchObject({ start_line: 503, end_line: 904 }); expect(tail.body).toContain('console.log(899)'); expect(tail.body).not.toContain('unrelated');
  expect(tail.next_line_offset).toBeUndefined(); expect(tail.recovery.line_offset).toBe(0);
});

it('keeps an explicit file scope, rejects stale declarations and still reads a new unindexed file', async () => {
  const { add, root, read } = fixture();
  add('target.ts', 'export function target() {}', [{ name: 'target' }]);
  add('other.ts', 'export function another() { target(); }');
  await expect(read({ file_path: 'other.ts' })).rejects.toThrow('SYMBOL_NOT_FOUND');
  writeFileSync(join(root, 'target.ts'), 'export function renamed() {}');
  await expect(read()).rejects.toThrow('SYMBOL_NOT_FOUND');
  writeFileSync(join(root, 'new.ts'), 'export function target() { return 42; }');
  expect((await read({ file_path: 'new.ts' })).value).toMatchObject({ file_path: 'new.ts', used_fallback: true, range_kind: 'parsed' });
});

it('pages all indexed ambiguity candidates and disambiguates same-file methods using current declaration lines', async () => {
  const { add, read } = fixture();
  for (let i = 0; i < 12; i++) add(`candidate${String(i).padStart(2, '0')}.ts`, 'export function target() {}', [{ name: 'target' }]);
  expect((await read()).value).toMatchObject({ error: 'ambiguous', total: 12, next_candidate_offset: 10 });
  expect((await read({ candidate_offset: 10 })).value.candidates).toHaveLength(2);
  add('methods.ts', 'class A {\n target() { return 1; }\n}\nclass B {\n target() { return 2; }\n}');
  const ambiguous = (await read({ file_path: 'methods.ts' })).value;
  expect(ambiguous.error).toBe('ambiguous'); expect(ambiguous.candidates.map((s: { line: number }) => s.line)).toEqual([2, 5]);
  const selected = (await read({ file_path: 'methods.ts', declaration_line: 5 })).value;
  expect(selected.body).toContain('return 2'); expect(selected.body).not.toContain('return 1');
  await expect(read({ file_path: 'methods.ts', declaration_line: 3 })).rejects.toThrow('SYMBOL_NOT_FOUND');
});

it('uses bounded asynchronous file discovery with explicit page recovery and heuristic range labels', async () => {
  const { add, read, root, db } = fixture();
  for (let i = 0; i < 101; i++) add(`f${String(i).padStart(3, '0')}.ts`, i === 100 ? 'export function target() {}' : 'export const unrelated = 1;');
  vi.spyOn(db, 'listFiles').mockImplementation(() => { throw new Error('full file hydration'); });
  await expect(read()).rejects.toThrow('file_scan_offset');
  expect((await read({ file_scan_offset: 100 })).value.file_path).toBe('f100.ts');
  writeFileSync(join(root, 'plain.txt'), 'function target() {\n return 1;\n}\nmore');
  const heuristic = await read({ file_path: 'plain.txt' });
  expect(heuristic.value).toMatchObject({ range_kind: 'heuristic', truncated: true, recovery: { tool: 'read_file' } });
  expect(heuristic.value.total_lines).toBeUndefined();
  expect(heuristic.result).toMatchObject({ sourceTruncations: [{ inputSizeExact: false, recoverable: true }] });
});

it('rejects unsafe paths, invalid bounds, pre-abort and outside junctions', async () => {
  const { read, root, ctx } = fixture();
  await expect(read({ file_path: '../secret' })).rejects.toThrow('outside');
  for (const args of [{ max_lines: 501 }, { line_offset: -1 }, { symbol_name: '' }, { declaration_line: 1 }]) await expect(read(args)).rejects.toThrow();
  await expect(getSymbolBody.handler({ project_name: 'body-project', symbol_name: 'target' },
    { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
  const outside = mkdtempSync(join(tmpdir(), 'symbol-body-outside-'));
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.ts'), 'function target() {}');
  const link = join(root, 'outside'); symlinkSync(outside, link, 'junction');
  cleanup.push(() => unlinkSync(link));
  await expect(read({ file_path: 'outside/secret.ts' })).rejects.toThrow('outside');
});
