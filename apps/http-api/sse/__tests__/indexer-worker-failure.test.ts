import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StructuralExecutor } from '@mcp/services/services/project-index/index.js';
import { createStructuralIndexerExecutor, IndexerWorkerClient } from '../IndexerWorkerClient.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('structural worker failure isolation', () => {
  it('never executes a second copy on main after a worker operation fails', async () => {
    vi.stubEnv('MCP_INDEX_STRUCTURAL_WORKER', '1');
    vi.stubEnv('NODE_OPTIONS', '--import tsx/esm');
    const fallback = { runStructuralIndex: vi.fn(), indexFiles: vi.fn(), removeFiles: vi.fn() };
    vi.spyOn(IndexerWorkerClient.prototype, 'runStructuralIndex').mockRejectedValue(new Error('worker failed after a write'));
    const { executor, client } = createStructuralIndexerExecutor({ dbPath: 'unused.db', allowInProcessFallback: false }, fallback as StructuralExecutor);
    expect(client).not.toBeNull();
    await expect(executor.runStructuralIndex(1, {})).rejects.toThrow('worker failed');
    expect(fallback.runStructuralIndex).not.toHaveBeenCalled();
    await client?.dispose();
  });

  it('reports a missing/disabled desktop worker instead of freezing main', async () => {
    vi.stubEnv('MCP_INDEX_STRUCTURAL_WORKER', '0');
    const fallback = { runStructuralIndex: vi.fn(), indexFiles: vi.fn(), removeFiles: vi.fn() };
    const { executor } = createStructuralIndexerExecutor({ dbPath: 'unused.db', allowInProcessFallback: false }, fallback as StructuralExecutor);
    await expect(executor.indexFiles(1, ['a.ts'])).rejects.toThrow('worker unavailable');
    expect(fallback.indexFiles).not.toHaveBeenCalled();
  });
});
