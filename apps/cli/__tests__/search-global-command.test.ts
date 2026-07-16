import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projects = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  name: `project-${index + 1}`,
}));

const state = vi.hoisted(() => ({
  close: vi.fn(),
  print: vi.fn(),
  requestLocalServer: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@mcp/shared/utils/config.js', () => ({
  loadConfig: () => ({ dbPath: 'D:/data/index.db' }),
}));

vi.mock('@mcp/store/db.js', () => ({
  CodeIndexDB: class {
    listProjects() {
      return Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        name: `project-${index + 1}`,
      }));
    }
    close() { state.close(); }
  },
}));

vi.mock('../helpers.js', () => ({
  getQueryEmbeddingService: () => ({}),
  getVectorStore: () => ({}),
}));

vi.mock('../format.js', () => ({
  printSearchResults: state.print,
}));

vi.mock('../semantic-control.js', () => ({
  requestLocalServer: state.requestLocalServer,
}));

vi.mock('@mcp/indexer/search/hybrid.js', () => ({
  HybridSearch: class {
    search(...args: unknown[]) { return state.search(...args); }
  },
}));

import { register } from '../commands/search.js';

function globalSearch(): Promise<Command> {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program.parseAsync(['node', 'test', 'search', 'needle', '--global']);
}

describe('CLI global search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.requestLocalServer.mockResolvedValue({
      reached: false, ok: false, status: null, body: null, error: 'offline',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates global semantic search to one owner endpoint', async () => {
    const results = [{ project: 'project-2', id: 9, score: 0.91 }];
    state.requestLocalServer.mockResolvedValue({
      reached: true, ok: true, status: 200, body: results, error: null,
    });

    await globalSearch();

    expect(state.requestLocalServer).toHaveBeenCalledWith(
      '/api/search?q=needle&mode=auto&type=all&limit=20',
      { method: 'GET' },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(state.search).not.toHaveBeenCalled();
    expect(state.print).toHaveBeenCalledWith(results);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('falls back to FTS with fan-out capped at four when the owner is unavailable', async () => {
    let active = 0;
    let peak = 0;
    const release = new Map<number, () => void>();
    state.search.mockImplementation(async (projectId: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.set(projectId, resolve));
      active -= 1;
      return [{ projectId }];
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const pending = globalSearch();
    await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(4));
    release.get(4)?.();
    await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(5));
    release.get(2)?.();
    await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(6));
    for (const id of [1, 3, 5, 6]) release.get(id)?.();
    await pending;

    expect(peak).toBe(4);
    expect(state.print.mock.calls.map(([results]) => results[0].projectId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.search).toHaveBeenCalledWith(1, 'project-1', 'needle', {
      mode: 'fts', type: 'all', limit: 20,
    });
    expect(log.mock.calls.map(([message]) => message)).toEqual(
      projects.map((project) => `\n── ${project.name} ──`),
    );
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('reports one FTS fallback failure without cancelling the rest', async () => {
    state.search.mockImplementation(async (projectId: number) => {
      if (projectId === 2) throw new Error('database unavailable');
      return [{ projectId }];
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await globalSearch();

    expect(state.print.mock.calls.map(([results]) => results[0].projectId)).toEqual([1, 3, 4, 5, 6]);
    expect(error).toHaveBeenCalledWith('Search failed for project-2: database unavailable');
    expect(state.close).toHaveBeenCalledOnce();
  });
});
