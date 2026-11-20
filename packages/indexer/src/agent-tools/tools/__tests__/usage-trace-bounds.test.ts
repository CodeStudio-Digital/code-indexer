import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import type { IndexToolContext } from '../../context.js';
import { traceUsage } from '../usage-trace.js';
import { findReferences } from '../symbol-references.js';
import { symbolReferenceKind269 } from '@mcp/store/migrations/269_symbol_reference_kind.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'usage-trace-bounds-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('trace-project', root), other = db.createProject('other', root + '-other');
  const file = (path: string, projectId = project.id) => db.upsertFile(projectId, { path, language: 'typescript', size: 1000, lineCount: 1000, contentHash: 'fixture' });
  const id = file('graph.ts');
  db.upsertSymbols(project.id, id, 'graph.ts', ['A', 'B', 'C', 'Unrelated'].map((name, i) => ({ name, kind: 'function', signature: '()', parent: null,
    line: 1 + i * 10, end_line: 10 + i * 10, modifiers: [], return_type: null, parameters: null, exported: true, comment: null, tags: [] } as LLMSymbol)));
  const refs = (rows: Array<{ name: string; line: number }>) => db.upsertSymbolReferences(project.id, id, 'graph.ts', rows.map(r => ({ symbol_name: r.name, kind: 'call', line: r.line })));
  const ctx = { db } as IndexToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await traceUsage.handler({ project_name: project.name, symbol_name: 'A', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { root, db, project, other, file, refs, ctx, read };
}

it('retains same-file callers, follows their enclosing declarations and terminates cycles without unrelated symbols', async () => {
  const { refs, read } = fixture(); refs([{ name: 'A', line: 12 }, { name: 'B', line: 22 }, { name: 'C', line: 2 }]);
  const graph = (await read({ depth: 5 })).value;
  expect(graph.visited_nodes).toBe(3);
  expect(graph.callers[0].symbols_in_file).toEqual(['B']); expect(graph.callers[0].callers[0].symbols_in_file).toEqual(['C']);
  expect(graph.callers[0].callers[0].callers[0]).toMatchObject({ symbols_in_file: ['A'], stop: 'already_expanded' });
  expect(JSON.stringify(graph)).not.toContain('Unrelated'); expect(graph.truncations).toEqual([]);
});

it('caps materialization before traversing a thousand references and recovers omitted branches with exact counts', async () => {
  const { db, project, refs, read } = fixture(); refs(Array.from({ length: 1000 }, (_, i) => ({ name: 'A', line: i + 1 })));
  const graph = await read({ depth: 1 });
  expect(graph.value.callers).toHaveLength(5); expect(graph.value.visited_nodes).toBe(5);
  expect(graph.value.truncations).toContainEqual({ symbol: 'A', total: 1000, shown: 5, reason: 'breadth_limit' });
  expect(graph.value.recoveries[0].recovery).toMatchObject({ tool: 'find_references', symbol_name: 'A', offset: 5 });
  expect(graph.result).toMatchObject({ sourceTruncations: [{ inputSize: 1000, outputSize: 5, recoverable: true }] });
  expect(db.traceSymbolUsage(project.id, 'A', 1).callers).toHaveLength(5); // CLI shares the same bounded store path.
});

it('reports deeper omitted callers instead of expanding every symbol in each referencing file', async () => {
  const { refs, read } = fixture(); refs([{ name: 'A', line: 12 }, { name: 'B', line: 22 }]);
  const graph = (await read({ depth: 1 })).value;
  expect(graph.callers[0].callers).toEqual([]);
  expect(graph.truncations).toContainEqual({ symbol: 'B', total: 1, shown: 0, reason: 'depth_limit' });
  expect(graph.recoveries[0].recovery).toMatchObject({ symbol_name: 'B', offset: 0 });
});

it('validates depth and cancellation before executing the graph query', async () => {
  const { read, db, project, ctx } = fixture(), query = vi.spyOn(db, 'traceSymbolUsage');
  for (const depth of [0, -1, 6, 1.1, Infinity, '3']) await expect(read({ depth })).rejects.toThrow('depth');
  await expect(traceUsage.handler({ project_name: project.name, symbol_name: 'A' }, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
  expect(query).not.toHaveBeenCalled();
});

it('keeps imports out of the call graph and recovers call-only pages with the same ordering', async () => {
  const { db, project, file, refs, read, ctx } = fixture();
  refs(Array.from({ length: 12 }, (_, i) => ({ name: 'A', line: 11 + i })));
  const imports = file('aaa-imports.ts');
  db.upsertSymbolReferences(project.id, imports, 'aaa-imports.ts', Array.from({ length: 7 }, (_, i) => ({ symbol_name: 'A', kind: 'other', reference_kind: 'import', line: i + 1 })));
  const graph = (await read({ depth: 1 })).value;
  expect(graph.callers).toHaveLength(5); expect(graph.callers[0].file).toBe('graph.ts');
  expect(graph.truncations.find((t: { symbol: string }) => t.symbol === 'A').total).toBe(12);
  const recovery = graph.recoveries.find((t: { symbol: string }) => t.symbol === 'A').recovery;
  expect(recovery.reference_kind).toBe('call');
  const page = await findReferences.handler({ ...recovery, format: 'json' }, ctx);
  const value = JSON.parse(typeof page === 'string' ? page : page.text);
  expect(value.total).toBe(12); expect(value.references).toHaveLength(7);
  expect(value.references.every((r: { reference_kind: string }) => r.reference_kind === 'call')).toBe(true);
  await expect(findReferences.handler({ ...recovery, source: 'disk' }, ctx)).rejects.toThrow('cannot classify');
});

it('preserves old reference rows as unknown through migration instead of fabricating call classification', async () => {
  const { db, project, refs, read, ctx } = fixture(); refs([{ name: 'A', line: 12 }]);
  // Recreate the old schema before replaying migration 269. Newer update
  // triggers reference the column that this historical fixture removes.
  db.raw().exec('DROP TRIGGER IF EXISTS structural_revision_symbol_references_update; DROP INDEX idx_symbol_refs_project_name_kind; ALTER TABLE symbol_references DROP COLUMN reference_kind');
  symbolReferenceKind269.up(db.raw()); symbolReferenceKind269.up(db.raw());
  const graph = (await read()).value;
  expect(graph.callers).toEqual([]);
  expect(graph.truncations).toEqual([{ symbol: 'A', total: 1, shown: 0, reason: 'unclassified_references' }]);
  expect(graph.recoveries[0].recovery.reference_kind).toBe('unknown');
  const page = await findReferences.handler({ ...graph.recoveries[0].recovery, format: 'json' }, ctx);
  expect(JSON.parse(typeof page === 'string' ? page : page.text).references[0].reference_kind).toBeNull();
  expect(db.listAgentSymbolReferences(project.id, 'A', { limit: 5, offset: 0, referenceKind: 'call' }).total).toBe(0);
});

it('bounds a branching graph globally and keeps another project out of its caller counts', async () => {
  const { db, project, other, file, read } = fixture(), id = file('branch.ts'), foreign = file('foreign.ts', other.id);
  db.upsertSymbols(project.id, id, 'branch.ts', Array.from({ length: 781 }, (_, i) => ({ name: 'Fn' + i, kind: 'function', signature: '()', parent: null,
    line: i * 10 + 1, end_line: i * 10 + 10, modifiers: [], return_type: null, parameters: null, exported: true, comment: null, tags: [] } as LLMSymbol)));
  db.upsertSymbolReferences(project.id, id, 'branch.ts', Array.from({ length: 780 }, (_, i) => ({ symbol_name: 'Fn' + Math.floor(i / 5), kind: 'call', line: (i + 1) * 10 + 2 })));
  db.upsertSymbolReferences(other.id, foreign, 'foreign.ts', [{ symbol_name: 'Fn0', kind: 'call', line: 1 }]);
  const graph = (await read({ symbol_name: 'Fn0', depth: 5 })).value;
  expect(graph.visited_nodes).toBeGreaterThan(5); expect(graph.visited_nodes).toBeLessThanOrEqual(100);
  expect(graph.truncations.some((t: { reason: string }) => ['node_limit', 'time_limit'].includes(t.reason))).toBe(true);
  expect(JSON.stringify(graph)).not.toContain('foreign.ts');
});
