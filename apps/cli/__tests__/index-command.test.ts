import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  close: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@mcp/shared/utils/config.js', () => ({
  loadConfig: () => ({ dbPath: 'D:/data/index.db', dashboard: { host: '127.0.0.1', port: 7333 } }),
}));

vi.mock('@mcp/store/db.js', () => ({
  CodeIndexDB: class {
    getProjectByPath() { return { id: 7, name: 'demo', root_path: 'D:/demo' }; }
    close() { state.close(); }
  },
}));

vi.mock('../semantic-control.js', () => ({ requestLocalServer: state.request }));

import { register } from '../commands/index-cmd.js';

describe('CLI index command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.request
      .mockResolvedValueOnce({
        reached: true,
        ok: true,
        status: 200,
        body: { ok: true, status: { phase: 'ready' } },
        error: null,
      })
      .mockResolvedValueOnce({
        reached: true,
        ok: true,
        status: 202,
        body: { ok: true, job: { id: 31, status: 'pending' } },
        error: null,
      });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it.each([false, true])('selects the structural operation independently of semantic reindexing (rebuild: %s)', async rebuild => {
    const program = new Command();
    program.exitOverride();
    register(program);
    const command = program.commands.find((candidate) => candidate.name() === 'index')!;

    await program.parseAsync(['node', 'test', 'index', 'D:/demo', ...(rebuild ? ['--rebuild-structural'] : [])]);

    expect(command.options.map((option) => option.long)).toEqual([
      '--structural-only',
      '--rebuild-structural',
      '--rebuild-semantic',
    ]);
    expect(state.request).toHaveBeenNthCalledWith(
      1,
      `/api/projects/7/index/structural/${rebuild ? 'reconcile' : 'refresh'}`,
      { method: 'POST' },
      expect.objectContaining({ timeoutMs: 190_000 }),
    );
    expect(state.request).toHaveBeenNthCalledWith(
      2,
      '/api/projects/7/semantic/reindex',
      { method: 'POST', body: JSON.stringify({ action: 'start' }) },
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(state.close).toHaveBeenCalledOnce();
  });
});

