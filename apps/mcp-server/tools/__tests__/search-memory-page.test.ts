import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import type { ToolContext } from '../../context.js';
import { searchMemory } from '../search-memory.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-page-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('memory-project', root), other = db.createProject('other', root + '-other');
  const save = (name: string, content: string, projectId = project.id) => db.createAgentMemory({ name, content, projectId, scope: 'project', type: 'convention', source: 'agent' });
  const long = save('Long memory', '😀'.repeat(9000)), short = save('Short memory', 'Current short content.'), foreign = save('Foreign memory', 'Never exposed', other.id);
  const remote = vi.fn(async () => ({ ok: true, error: null, value: { results: [{ id: short.id, score: 1 }, { id: long.id, score: 0.5 }] } }));
  const local = vi.fn(async () => [{ id: short.id }]);
  const ctx = { db, semanticSearchClient: { searchProjectMemory: remote }, agentMemoryService: { search: local } } as unknown as ToolContext;
  const read = async (args: Record<string, unknown> = {}) => {
    const result = await searchMemory.handler({ project_name: project.name, query: 'memory', format: 'json', ...args }, ctx);
    return { result, value: JSON.parse(typeof result === 'string' ? result : result.text) };
  };
  return { db, project, short, long, foreign, remote, local, ctx, read };
}

it('loads bounded current content in one scoped query and preserves semantic rank without trusting response bodies', async () => {
  const { db, read, short, long } = fixture();
  vi.spyOn(db, 'getAgentMemoryById').mockImplementation(() => { throw new Error('full hydration'); });
  vi.spyOn(db, 'getAgentMemoriesByIds').mockImplementation(() => { throw new Error('full hydration'); });
  const result = await read();
  expect(result.value.results.map((r: { id: number }) => r.id)).toEqual([short.id, long.id]);
  expect(result.value.results[1].content).toBe('😀'.repeat(4000));
  expect(result.value.results[1].recovery).toMatchObject({ memory_id: long.id, content_offset: 4000 });
  expect(result.result).toMatchObject({ sourceTruncations: [{ technique: 'mcp-memory-content-page', inputSize: 9000, outputSize: 4000, unit: 'chars', recoverable: true }] });
});

it('recovers Unicode content by ID without repeating semantic retrieval and reports offsets past the end', async () => {
  const { read, long, remote, local } = fixture();
  const tail = (await read({ memory_id: long.id, content_offset: 8000 })).value;
  expect(tail.results[0].content).toBe('😀'.repeat(1000)); expect(tail.results[0].recovery.content_offset).toBe(0);
  const past = (await read({ memory_id: long.id, content_offset: 10000 })).value;
  expect(past.results[0].content).toBe(''); expect(past.results[0].recovery.content_offset).toBe(0);
  expect(remote).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
});

it('drops foreign and archived memories, rejects scoped ID reads and keeps an empty JSON response parseable', async () => {
  const { db, read, long, short, foreign, remote } = fixture();
  db.raw().prepare("UPDATE agent_memory SET archived_at=datetime('now') WHERE id=?").run(long.id);
  remote.mockResolvedValue({ ok: true, error: null, value: { results: [{ id: foreign.id, score: 1 }, { id: long.id, score: 0.8 }, { id: short.id, score: 0.6 }] } });
  expect((await read()).value.results.map((r: { id: number }) => r.id)).toEqual([short.id]);
  await expect(read({ memory_id: foreign.id })).rejects.toThrow('this project');
  await expect(read({ memory_id: long.id })).rejects.toThrow('this project');
  remote.mockResolvedValue({ ok: true, error: null, value: { results: [] } });
  expect((await read()).value).toMatchObject({ total: 0, results: [], source: 'semantic_owner' });
});

it('rejects invalid pages and aborts before local-store or semantic work', async () => {
  const { read, remote, db, project, ctx } = fixture(), load = vi.spyOn(db, 'getProjectMemoryContentPages');
  for (const args of [{ limit: 51 }, { content_offset: -1 }, { content_offset: 1 }, { content_limit: 16385 }, { content_limit: 1.5 }, { memory_id: -1 }]) await expect(read(args)).rejects.toThrow();
  await expect(searchMemory.handler({ project_name: project.name, memory_id: 1 }, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
  expect(remote).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});
