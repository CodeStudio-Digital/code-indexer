import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import type { ToolContext } from '../../context.js';
import { findImplementations, getHierarchy } from '../type-relations.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'type-relations-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('types-project', root), other = db.createProject('other', root + '-other');
  const add = (path: string, specs: Array<Partial<LLMSymbol> & { name: string }>, projectId = project.id) => {
    const id = db.upsertFile(projectId, { path, language: 'typescript', size: 1, lineCount: specs.length, contentHash: 'fixture' });
    db.upsertSymbols(projectId, id, path, specs.map((s, i) => ({ kind: 'class', signature: '', parent: null, modifiers: [],
      return_type: null, parameters: null, line: i + 1, exported: true, comment: 'large comment'.repeat(500), tags: [], ...s } as LLMSymbol)));
  };
  const ctx = { db } as ToolContext;
  const call = async (tool: typeof getHierarchy | typeof findImplementations, args: Record<string, unknown>) => {
    const result = await tool.handler({ project_name: project.name, format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, other, add, ctx, call };
}

it('pages implementations in SQL, deduplicates duplicate edges and isolates projects without hydrating comments', async () => {
  const { add, db, other, call } = fixture();
  add('items.ts', Array.from({ length: 553 }, (_, i) => ({ name: 'Type' + String(i).padStart(4, '0'), implements_list: ['Port', 'Port'] })));
  add('private.ts', [{ name: 'OtherProject', implements_list: ['Port'] }], other.id);
  vi.spyOn(db, 'getImplementors').mockImplementation(() => { throw new Error('unbounded hydration'); });
  const first = await call(findImplementations, { interface_name: 'Port', limit: 500 });
  expect(first.value).toMatchObject({ total: 553, shown: 500, next_offset: 500 });
  expect(first.result).toMatchObject({ sourceTruncations: [{ inputSize: 553, outputSize: 500, recoverable: true }] });
  expect(first.value.implementations[0].comment).toBeUndefined();
  const tail = (await call(findImplementations, { interface_name: 'Port', offset: 500, limit: 100 })).value;
  expect(tail.shown).toBe(53); expect(tail.implementations.at(-1).name).toBe('Type0552'); expect(tail.next_offset).toBeUndefined();
  const empty = (await call(findImplementations, { interface_name: 'Port', offset: 999 })).value;
  expect(empty).toMatchObject({ total: 553, shown: 0, recovery: { offset: 0 } });
});

it('pages parents and children together and preserves traits, namespaces and a bounded transitive chain', async () => {
  const { add, db, call } = fixture();
  add('root.ts', [{ name: 'Root', extends_from: 'Base', implements_list: ['Port'], uses_traits: ['Mixin'], namespace: 'App' }]);
  add('base.ts', [{ name: 'Base', extends_from: 'Grand' }, { name: 'Grand' }]);
  add('children.ts', Array.from({ length: 553 }, (_, i) => ({ name: 'Child' + i, extends_from: 'Root', namespace: 'Children' })));
  vi.spyOn(db, 'getSymbolHierarchy').mockImplementation(() => { throw new Error('unbounded graph'); });
  vi.spyOn(db, 'getExtendsChain').mockImplementation(() => { throw new Error('unbounded graph'); });
  const first = (await call(getHierarchy, { symbol_name: 'Root', limit: 500 })).value;
  expect(first).toMatchObject({ total: 556, shown: 500, extends_chain: ['Base', 'Grand'], chain_stop: 'complete', next_offset: 500 });
  const tail = (await call(getHierarchy, { symbol_name: 'Root', offset: 500 })).value;
  expect(tail.shown).toBe(56);
  expect(tail.relations.filter((s: { direction: string }) => s.direction === 'parent').map((s: { name: string }) => s.name).sort())
    .toEqual(['Base', 'Mixin', 'Port']);
  expect(tail.note).toContain('indexed by name');
});

it('requires explicit disambiguation and never silently chooses a different file or project', async () => {
  const { add, root, call } = fixture();
  add('first.ts', [{ name: 'Same', extends_from: 'A' }]); add('second.ts', [{ name: 'Same', extends_from: 'B' }]);
  add('method.ts', [{ name: 'Same', kind: 'method' }]);
  const ambiguous = (await call(getHierarchy, { symbol_name: 'Same', limit: 1 })).value;
  expect(ambiguous).toMatchObject({ error: 'ambiguous', total: 2, next_offset: 1 });
  expect((await call(getHierarchy, { symbol_name: 'Same', offset: 1, limit: 1 })).value.candidates[0].file_path).toBe('second.ts');
  expect((await call(getHierarchy, { symbol_name: 'Same', file_path: join(root, 'second.ts') })).value.extends_chain).toEqual(['B']);
  await expect(call(getHierarchy, { symbol_name: 'Same', file_path: 'missing.ts' })).rejects.toThrow('SYMBOL_NOT_FOUND');
  await expect(call(getHierarchy, { symbol_name: 'Same', file_path: '../escape.ts' })).rejects.toThrow('outside');
  add('namespaces.ts', [{ name: 'Duplicate', namespace: 'A', extends_from: 'BaseA' }, { name: 'Duplicate', namespace: 'B', extends_from: 'BaseB' }]);
  expect((await call(getHierarchy, { symbol_name: 'Duplicate', file_path: 'namespaces.ts' })).value.error).toBe('ambiguous');
  expect((await call(getHierarchy, { symbol_name: 'Duplicate', file_path: 'namespaces.ts', declaration_line: 2 })).value.extends_chain).toEqual(['BaseB']);
});

it('terminates cyclic and deep ancestry and exposes unresolved/ambiguous parents', async () => {
  const { add, call } = fixture();
  add('chain.ts', Array.from({ length: 8 }, (_, i) => ({ name: 'T' + i, ...(i < 7 ? { extends_from: 'T' + (i + 1) } : {}) })));
  const deep = await call(getHierarchy, { symbol_name: 'T0' });
  expect(deep.value.extends_chain).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']); expect(deep.value.chain_stop).toBe('depth_limit');
  expect(deep.result).toMatchObject({ sourceTruncations: [{ technique: 'mcp-hierarchy-chain-depth_limit', inputSizeExact: false }] });
  add('cycle.ts', [{ name: 'A', extends_from: 'B' }, { name: 'B', extends_from: 'A' }]);
  expect((await call(getHierarchy, { symbol_name: 'A' })).value.chain_stop).toBe('cycle');
  add('dup.ts', [{ name: 'B' }]); expect((await call(getHierarchy, { symbol_name: 'A' })).value.chain_stop).toBe('ambiguous');
  add('missing.ts', [{ name: 'Unresolved', extends_from: 'Unknown' }]);
  expect((await call(getHierarchy, { symbol_name: 'Unresolved' })).value.chain_stop).toBe('unindexed');
  add('branch.ts', [{ name: 'Branch', kind: 'interface', extends_from: 'First', extends_list: ['First', 'Second'] }]);
  const branch = (await call(getHierarchy, { symbol_name: 'Branch' })).value;
  expect(branch.chain_stop).toBe('branching'); expect(branch.relations).toHaveLength(2);
});

it('rejects invalid input and observes cancellation before querying the index', async () => {
  const { call, ctx, db } = fixture(); const query = vi.spyOn(db, 'listAgentImplementations');
  for (const args of [{ interface_name: '' }, { interface_name: 'T', limit: 501 }, { interface_name: 'T', offset: -1 },
    { interface_name: 'T', offset: 0.5 }, { interface_name: 9 }]) await expect(call(findImplementations, args)).rejects.toThrow('Invalid');
  expect(() => findImplementations.handler({ project_name: 'types-project', interface_name: 'T' },
    { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).toThrow('stopped');
  expect(query).not.toHaveBeenCalled();
});
