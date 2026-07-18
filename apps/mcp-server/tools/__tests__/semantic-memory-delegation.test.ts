import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../context.js';
import { snapshotTools } from '../snapshots.js';

const tool = snapshotTools.find((candidate) => candidate.name === 'search_memory')!;
const project = { id: 7, name: 'demo', root_path: 'D:/demo' };
const hit = {
  id: 3,
  project_id: 7,
  scope: 'project',
  name: 'Testing convention',
  type: 'convention',
  content: 'Run focused Vitest suites first.',
  source: 'agent',
  importance: 0.8,
  score: 0.03,
};

function fixture(remoteOk: boolean) {
  const searchProjectMemory = vi.fn(async () => remoteOk
    ? { ok: true, error: null, value: { results: [hit] } }
    : { ok: false, error: 'server stopped', value: null });
  const localSearch = vi.fn(async () => [hit]);
  return {
    ctx: {
      db: {
        getProjectByName: () => project,
        countAgentMemory: () => 1,
      },
      semanticSearchClient: { searchProjectMemory },
      agentMemoryService: { search: localSearch },
    } as unknown as ToolContext,
    searchProjectMemory,
    localSearch,
  };
}

describe('mcp project-memory semantic delegation', () => {
  it('uses the server-owned knowledge vectors when available', async () => {
    const h = fixture(true);
    const output = await tool.handler({
      project_name: 'demo', query: 'how should tests run?', format: 'json',
    }, h.ctx);

    expect(h.searchProjectMemory).toHaveBeenCalledWith(7, 'how should tests run?', 5);
    expect(h.localSearch).not.toHaveBeenCalled();
    expect(JSON.parse(typeof output === 'string' ? output : output.text)).toMatchObject({ semantic: true, total: 1 });
  });

  it('falls back to local memory FTS when the owner is unavailable', async () => {
    const h = fixture(false);
    const output = await tool.handler({
      project_name: 'demo', query: 'testing convention', format: 'text',
    }, h.ctx);

    expect(h.localSearch).toHaveBeenCalledWith('project', 7, 'testing convention', 5);
    const text = typeof output === 'string' ? output : output.text;
    expect(text).toContain('Testing convention');
    expect(text).toContain('FTS-only');
    expect(text).toContain('server stopped');
  });
});
