import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMSymbol } from '@mcp/shared/types.js';
import type { ToolContext } from '../../context.js';
import { getRepoMap } from '@mcp/indexer/agent-tools/tools/repo-map.js';
import { buildRepoMap as promptMap } from '@mcp/code-agent/core/repo-map.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture(count = 10) {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('map-project', root);
  const file = (path: string, projectId = project.id) => db.upsertFile(projectId, { path, language: 'typescript', size: 100, lineCount: 100, contentHash: 'fixture' });
  const symbol = (name: string, line: number, parent: string | null = null) => ({ name, kind: 'function', signature: '😀'.repeat(100), parent, line,
    modifiers: [], return_type: null, parameters: null, exported: true, comment: null, tags: [] } as LLMSymbol);
  db.raw().transaction(() => {
    for (let i = 0; i < count; i++) {
      const path = `src/file${String(i).padStart(4, '0')}.ts`, id = file(path);
      db.upsertSymbols(project.id, id, path, Array.from({ length: 8 }, (_, j) => symbol('Symbol' + j, j + 1, j === 7 ? 'Parent' : null)));
    }
  })();
  const ctx = { db } as ToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await getRepoMap.handler({ project_name: project.name, format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { db, project, root, file, symbol, ctx, read };
}

it('returns only the requested ranked file page and three symbol previews without legacy full hydration', async () => {
  const { db, read } = fixture(553);
  for (const key of ['listFiles', 'getSymbolsByFile', 'getDependents'] as const) vi.spyOn(db, key).mockImplementation(() => { throw new Error('unbounded hydration'); });
  const first = await read({ limit: 2 });
  expect(first.value).toMatchObject({ total: 553, shown: 2, next_offset: 2 });
  expect(first.value.files[0].symbols).toHaveLength(3);
  expect(first.value.files[0].symbols[0].signature).toBe('😀'.repeat(80));
  expect(first.result).toMatchObject({ sourceTruncations: expect.arrayContaining([
    expect.objectContaining({ technique: 'mcp-repo-map-file-page', inputSize: 553, outputSize: 2 }),
    expect.objectContaining({ technique: 'mcp-repo-map-symbol-preview', inputSize: 16, outputSize: 6 }),
    expect.objectContaining({ technique: 'mcp-repo-map-signature-preview', inputSize: 600, outputSize: 480 }),
  ]) });
  const tail = (await read({ offset: 550 })).value;
  expect(tail.files).toHaveLength(3); expect(tail.files.at(-1).path).toBe('src/file0552.ts');
  expect(tail.recovery.offset).toBe(0);
});

it('ranks dependency hubs and entrypoint paths, counts distinct importers, and isolates projects', async () => {
  const { db, project, root, file, read } = fixture(0);
  const hub = file('hub.ts'), importer = file('client.ts'); file('server.ts');
  db.upsertFileDependencies(project.id, importer, 'client.ts', ['./hub', './hub.ts'], []);
  const foreign = db.createProject('foreign', root + '-foreign'); file('foreign.ts', foreign.id);
  const value = (await read()).value;
  expect(value.total).toBe(3); expect(value.files[0].path).toBe('server.ts');
  expect(value.files.find((f: { id: number; path: string }) => f.path === 'hub.ts').dependent_count).toBe(1);
  expect(value.files[0].is_entry_point).toBe(1); expect(hub).toBeGreaterThan(0);
});

it('bounds the prompt map by recent files and top-level symbols without loading full rows', () => {
  const { db, project } = fixture(90);
  db.raw().prepare("UPDATE files SET updated_at='2099-01-01' WHERE project_id=? AND path=?").run(project.id, 'src/file0089.ts');
  vi.spyOn(db, 'listFiles').mockImplementation(() => { throw new Error('full files'); });
  vi.spyOn(db, 'getSymbolsByFile').mockImplementation(() => { throw new Error('full symbols'); });
  const page = db.listAgentRepoMap(project.id, { order: 'recent', limit: 80 });
  expect(page.items).toHaveLength(80); expect(page.items[0].path).toBe('src/file0089.ts');
  expect(page.items[0].symbols).toHaveLength(6); expect(page.items[0].symbol_count).toBe(7);
  const map = promptMap(db, project.id, 1000);
  expect(map).toContain('file0089.ts'); expect(map).not.toContain('Symbol7');
  expect(map).toContain('10 further indexed files');
});

it('preserves parseable JSON and labels independent file and text omissions', async () => {
  const { ctx, project, read } = fixture();
  const result = await getRepoMap.handler({ project_name: project.name, limit: 2, max_tokens: 20 }, ctx);
  expect(result).toMatchObject({ sourceTruncations: expect.arrayContaining([
    expect.objectContaining({ technique: 'mcp-repo-map-file-page' }), expect.objectContaining({ technique: 'mcp-repo-map-token-budget', outputSize: expect.any(Number) }),
  ]) });
  await expect(read({ max_tokens: 10 })).rejects.toThrow('text only');
  const pastEnd = (await read({ offset: 999 })).value;
  expect(pastEnd.shown).toBe(0); expect(pastEnd.recovery.offset).toBe(0);
});

it('rejects invalid inputs and cancellation before querying, and handles empty projects', async () => {
  const { db, read, ctx, project } = fixture(0), query = vi.spyOn(db, 'listAgentRepoMap');
  for (const args of [{ offset: -1 }, { limit: 501 }, { limit: 0 }, { limit: 1.5 }, { offset: '1' }, { max_tokens: -1 }]) await expect(read(args)).rejects.toThrow('Invalid');
  query.mockClear();
  expect(() => getRepoMap.handler({ project_name: project.name }, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).toThrow('stopped');
  expect(query).not.toHaveBeenCalled(); expect((await read()).value.files).toEqual([]);
});
