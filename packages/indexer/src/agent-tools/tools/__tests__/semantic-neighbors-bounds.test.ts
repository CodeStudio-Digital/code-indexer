import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { IndexToolContext } from '../../context.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import { semanticNeighbors } from '../semantic-neighbors.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'semantic-neighbor-bounds-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('neighbors-project', root), other = db.createProject('other', root + '-other');
  const add = (name: string, projectId = project.id) => {
    const path = name + '.ts'; writeFileSync(join(root, path), '// shift\nexport function ' + name + '() { return "CURRENT_BODY"; }');
    const id = db.upsertFile(projectId, { path, language: 'typescript', size: 100, lineCount: 2, contentHash: 'fixture' });
    db.upsertSymbols(projectId, id, path, [{ name, kind: 'function', signature: '()', parent: null, modifiers: [], line: 1,
      end_line: 1, exported: true, comment: 'description '.repeat(1000), tags: [], return_type: null, parameters: null } as LLMSymbol]);
    return db.findSymbolByName(projectId, name)!.id;
  };
  const seed = add('seed'), neighbor = add('neighbor'), foreign = add('foreign', other.id);
  const result = (id: number, score = 0.9) => ({ type: 'symbol', id, score, data: { name: 'FORGED_DATA', project_id: other.id } });
  const searchProject = vi.fn(async (_projectId: number, _query: string) => ({ ok: true, error: null, value: { results: [result(seed), result(neighbor), result(neighbor), result(foreign), result(99999), result(neighbor, NaN)],
    diagnostics: { vectorAvailable: true, embeddingAvailable: true } } }));
  const fallback = vi.fn(async () => ({ results: [], diagnostics: { vectorAvailable: false, embeddingAvailable: false } }));
  const ctx = { db, semanticSearchClient: { searchProject }, hybridSearch: { searchWithDiag: fallback } } as unknown as IndexToolContext;
  const read = (args: Record<string, unknown> = {}, signal?: AbortSignal) => semanticNeighbors.handler({ project_name: project.name, symbol_id: seed, format: 'json', ...args }, { ...ctx, signal });
  return { root, db, project, seed, neighbor, foreign, ctx, read, searchProject, fallback };
}

it('uses bounded current bytes and one scoped metadata query, excludes stale/foreign/duplicate results and preserves ranking', async () => {
  const { db, read, searchProject, neighbor } = fixture();
  vi.spyOn(db, 'getSymbolById').mockImplementation(() => { throw new Error('full row hydration'); });
  const bulk = vi.spyOn(db, 'listAgentSemanticNeighbors');
  const output = JSON.parse(String(await read()));
  expect(output).toMatchObject({ source: 'semantic', query_basis: 'current_body_excerpt', shown: 1 });
  expect(output.neighbors[0]).toMatchObject({ id: neighbor, name: 'neighbor' }); expect(JSON.stringify(output)).not.toContain('FORGED_DATA');
  expect(bulk).toHaveBeenCalledTimes(1);
  const query = searchProject.mock.calls[0][1] as string;
  expect(query.length).toBeLessThanOrEqual(4096); expect(query).toContain('CURRENT_BODY');
  expect(db.getAgentSemanticSeed(neighbor)!.comment!.length).toBeLessThanOrEqual(1024);
});

it('rejects invalid ids/limits and nonexistent projects before any semantic request', async () => {
  const { read, searchProject, foreign } = fixture();
  for (const args of [{ symbol_id: 0 }, { symbol_id: NaN }, { limit: 51 }, { limit: -1 }, { project_name: 'missing' }, { symbol_id: foreign }]) {
    await expect(read(args)).rejects.toThrow();
  }
  expect(searchProject).not.toHaveBeenCalled();
});

it('supports symbol names returned by search without requiring hidden surrogate ids', async () => {
  const { read, neighbor } = fixture();
  const output = JSON.parse(String(await read({ symbol_id: undefined, symbol_name: 'seed', file_path: 'seed.ts' })));
  expect(output.shown).toBe(1); expect(output.neighbors[0].id).toBe(neighbor);
  await expect(read({ symbol_name: 'not-the-seed' })).rejects.toThrow('does not match');
  await expect(read({ symbol_id: undefined, symbol_name: 'seed', file_path: 'neighbor.ts' })).rejects.toThrow('not found');
});

it('keeps cancellation out of the lexical fallback and discards late remote results', async () => {
  const { read, ctx, searchProject, fallback } = fixture();
  const controller = new AbortController();
  ctx.semanticSearchClient.searchProject = vi.fn(async () => { controller.abort(new Error('stopped')); return { ok: false, error: 'cancelled', value: null }; });
  await expect(read({}, controller.signal)).rejects.toThrow('stopped');
  expect(fallback).not.toHaveBeenCalled(); expect(searchProject).not.toHaveBeenCalled();
});

it('does not force a large body into memory and identifies lexical-only results', async () => {
  const { root, read, ctx, fallback } = fixture();
  writeFileSync(join(root, 'seed.ts'), 'x'.repeat(1024 * 1024 + 20));
  ctx.semanticSearchClient.searchProject = vi.fn(async () => ({ ok: false, error: 'offline', value: null }));
  const output = JSON.parse(String(await read()));
  expect(output).toMatchObject({ source: 'lexical_fallback', query_basis: 'structural' });
  expect(output.warnings.join(' ')).toContain('1 MiB'); expect(fallback).toHaveBeenCalledTimes(1);
});
