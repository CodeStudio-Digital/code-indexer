import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import type { ToolContext } from '../../context.js';
import { prepareEdit } from '../prepare-edit.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-edit-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('edit-project', root);
  const file = (path: string, isTest = false) => db.upsertFile(project.id, { path, isTest, language: 'typescript', size: 100, lineCount: 100, contentHash: 'fixture' });
  const id = file('target.ts');
  writeFileSync(join(root, 'target.ts'), ['export function target() {', ...Array.from({ length: 600 }, (_, i) => ` return ${i};`), '}', 'export function next() {}'].join('\n'));
  const symbol = (name: string, line: number) => ({ name, kind: 'function', signature: '()', parent: null, line, end_line: line + 1,
    modifiers: [], return_type: null, parameters: null, exported: true, comment: null, tags: [] } as LLMSymbol);
  db.upsertSymbols(project.id, id, 'target.ts', [symbol('target', 1), symbol('next', 603)]);
  db.upsertSymbolReferences(project.id, id, 'target.ts', [{ symbol_name: 'target', kind: 'call', line: 2 }]);
  const callerId = file('caller.ts'); db.upsertSymbolReferences(project.id, callerId, 'caller.ts', Array.from({ length: 553 }, (_, i) => ({ symbol_name: 'target', kind: 'call', line: i + 1 })));
  for (let i = 0; i < 7; i++) {
    const path = `test${i}.test.ts`, testId = file(path, true);
    db.upsertFileDependencies(project.id, testId, path, ['./target'], []);
  }
  db.upsertFileDependencies(project.id, id, 'target.ts', [], Array.from({ length: 103 }, (_, i) => `library${String(i).padStart(3, '0')}`));
  const ctx = { db } as ToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await prepareEdit.handler({ project_name: project.name, symbol_name: 'target', file_path: 'target.ts', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, id, file, symbol, read, ctx };
}

it('pages callers/imports/tests in SQL with proximity ordering and without legacy full-row queries', async () => {
  const { read, db } = fixture();
  for (const key of ['getSymbolCallers', 'getSymbolsByFile', 'getFile', 'getDependents', 'listFiles'] as const) vi.spyOn(db, key).mockImplementation(() => { throw new Error('unbounded hydration'); });
  const first = await read({ max_callers: 1, max_imports: 2, max_lines: 2 });
  expect(first.value.callers).toMatchObject({ total: 554, shown: 1, recovery: { callers_offset: 1 } });
  expect(first.value.callers.items[0].file_path).toBe('target.ts');
  expect(first.value.callers.recovery.declaration_line).toBe(1);
  expect(first.value).toMatchObject({ imports_total: 103, imports_recovery: { imports_offset: 2 }, tests_covering_total: 7, tests_recovery: { tests_offset: 5 } });
  expect(first.value.imports).toHaveLength(2); expect(first.value.tests_covering).toHaveLength(5);
  expect(first.result).toMatchObject({ sourceTruncations: expect.arrayContaining([
    expect.objectContaining({ technique: 'mcp-prepare-edit-caller-cap', inputSize: 554, outputSize: 1 }),
    expect.objectContaining({ technique: 'mcp-prepare-edit-import-cap', inputSize: 103, outputSize: 2 }),
    expect.objectContaining({ technique: 'mcp-prepare-edit-test-cap', inputSize: 7, outputSize: 5 }),
  ]) });
  const tail = (await read({ callers_offset: 550, imports_offset: 100, tests_offset: 5 })).value;
  expect(tail.callers.items).toHaveLength(4); expect(tail.imports).toHaveLength(3); expect(tail.tests_covering).toHaveLength(2);
});

it('keeps context anchored to the declaration when reading a later body page', async () => {
  const { read } = fixture(); const result = (await read({ line_offset: 500, max_lines: 50 })).value;
  expect(result.body.start_line).toBe(501); expect(result.symbol.line).toBe(1);
  expect(result.neighbors.find((s: { name: string }) => s.name === 'target').is_target).toBe(true);
});

it('never changes a supplied file to a same-named symbol elsewhere and propagates ambiguity for unscoped requests', async () => {
  const { root, db, project, file, symbol, read } = fixture();
  writeFileSync(join(root, 'wrong.ts'), 'export function nope() { target(); }');
  await expect(read({ file_path: 'wrong.ts' })).rejects.toThrow('SYMBOL_NOT_FOUND');
  const id = file('other.ts'); writeFileSync(join(root, 'other.ts'), 'export function target() {}');
  db.upsertSymbols(project.id, id, 'other.ts', [symbol('target', 1)]);
  expect((await read({ file_path: undefined })).value).toMatchObject({ error: 'ambiguous', total: 2 });
  await expect(read({ file_path: '../outside.ts' })).rejects.toThrow('outside');
});

it('rejects invalid page inputs and cancellation before file/index work', async () => {
  const { read, db, project, ctx } = fixture(), query = vi.spyOn(db, 'listAgentSymbolDefinitions');
  for (const args of [{ max_callers: 51 }, { tests_offset: -1 }, { imports_offset: 0.5 }, { max_imports: 101 }, { max_tests: 51 }]) await expect(read(args)).rejects.toThrow('Invalid');
  await expect(prepareEdit.handler({ project_name: project.name, symbol_name: 'target' }, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
  expect(query).not.toHaveBeenCalled();
});

it('retains incomplete disk scan warnings instead of reporting missing callers as a complete scan', async () => {
  const { root, db, project, read } = fixture();
  db.raw().prepare('DELETE FROM symbol_references WHERE project_id=?').run(project.id);
  writeFileSync(join(root, 'large.ts'), 'target();\n'.repeat(150000));
  const { value } = await read({ search_path: 'large.ts' });
  expect(value.callers.total_exact).toBe(false);
  expect(value.notes.join(' ')).toMatch(/large|size|MiB|byte/i);
});
