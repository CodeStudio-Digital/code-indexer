import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  nullEmbedding: { name: 'null-embedding' },
  requestLocalServer: vi.fn(),
  hybridConstructor: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@mcp/shared/utils/config.js', () => ({
  loadConfig: () => ({ dbPath: 'D:/data/index.db' }),
}));

vi.mock('@mcp/store/db.js', () => ({
  CodeIndexDB: class {
    resolveProject() { return { id: 7, name: 'demo' }; }
    listProjects() { return [{ id: 7, name: 'demo' }]; }
    close() {}
  },
}));

vi.mock('@mcp/indexer/search/embeddings.js', () => ({
  NullEmbeddingService: class {
    constructor() { return state.nullEmbedding; }
  },
}));

vi.mock('../semantic-control.js', () => ({
  requestLocalServer: state.requestLocalServer,
}));

vi.mock('../format.js', () => ({ printSearchResults: vi.fn() }));

vi.mock('@mcp/indexer/search/hybrid.js', () => ({
  HybridSearch: class {
    constructor(db: unknown, vectorStore: unknown, embeddingService: unknown) {
      state.hybridConstructor(db, vectorStore, embeddingService);
    }
    search(...args: unknown[]) { return state.search(...args); }
  },
}));

import { register } from '../commands/search.js';

describe('CLI single-project search ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.requestLocalServer.mockResolvedValue({
      reached: false, ok: false, status: null, body: null, error: 'offline',
    });
    state.search.mockResolvedValue([]);
  });

  it('delegates semantic search to the owner and keeps the offline fallback FTS-only', async () => {
    const program = new Command();
    program.exitOverride();
    register(program);

    await program.parseAsync(['node', 'test', 'search', 'needle', '--project', 'demo']);

    expect(state.requestLocalServer).toHaveBeenCalledWith(
      '/api/projects/7/search?q=needle&mode=auto&type=all&limit=20',
      { method: 'GET' },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(state.hybridConstructor).toHaveBeenCalledWith(
      expect.anything(),
      null,
      state.nullEmbedding,
    );
    expect(state.search).toHaveBeenCalledWith(7, 'demo', 'needle', {
      mode: 'fts', type: 'all', limit: 20,
    });
  });

  it('delegates explicit FTS mode too, using local FTS only when the owner is offline', async () => {
    const program = new Command();
    program.exitOverride();
    register(program);

    await program.parseAsync([
      'node', 'test', 'search', 'ExactSymbol', '--project', 'demo', '--mode', 'fts',
    ]);

    expect(state.requestLocalServer).toHaveBeenCalledWith(
      '/api/projects/7/search?q=ExactSymbol&mode=fts&type=all&limit=20',
      { method: 'GET' },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(state.search).toHaveBeenCalledWith(7, 'demo', 'ExactSymbol', {
      mode: 'fts', type: 'all', limit: 20,
    });
  });
});
