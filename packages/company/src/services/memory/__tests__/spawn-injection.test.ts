/**
 * PROJECT MEMORY spawn block — gates, caps and failure posture. Memory can
 * never break or delay a spawn beyond the timeout race: every failure path
 * must yield '' (no block), never a throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjectMemoryBlock } from '../spawn-injection.js';
import { setCompanyMemoryPorts, type CompanyMemoryPorts } from '../ports.js';

const ENABLED_DB = { getProjectMemoryEnabled: () => true };

function portsWith(items: Array<{ id: string; title: string; content: string; staleNote?: string }>): CompanyMemoryPorts {
  return {
    memoryRetriever: { retrieve: vi.fn().mockResolvedValue(items) },
    runEndMemory: { extractAndPersist: vi.fn(), isConfigured: vi.fn().mockResolvedValue(true) },
  };
}

afterEach(() => setCompanyMemoryPorts(null));

describe('fetchProjectMemoryBlock', () => {
  it('renders a bounded markdown section with stale notes', async () => {
    setCompanyMemoryPorts(
      portsWith([
        { id: '1', title: 'Auth decision', content: 'JWT over sessions.' },
        { id: '2', title: 'Worker gotcha', content: 'Globals do not cross worker_threads.', staleNote: 'src/boot.ts changed since recorded' },
      ]),
    );
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'implement login flow',
      db: ENABLED_DB,
    });
    expect(block).toContain('## PROJECT MEMORY');
    expect(block).toContain('**Auth decision**');
    expect(block).toContain('JWT over sessions.');
    expect(block).toContain('[STALE: src/boot.ts changed since recorded]');
  });

  it('returns empty when project memory is disabled', async () => {
    setCompanyMemoryPorts(portsWith([{ id: '1', title: 't', content: 'c' }]));
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'task',
      db: { getProjectMemoryEnabled: () => false },
    });
    expect(block).toBe('');
  });

  it('returns empty when no ports are wired (tests / unwired host)', async () => {
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'task',
      db: ENABLED_DB,
    });
    expect(block).toBe('');
  });

  it('returns empty when retrieval times out instead of delaying the spawn', async () => {
    setCompanyMemoryPorts({
      memoryRetriever: { retrieve: () => new Promise(() => { /* hangs */ }) },
      runEndMemory: { extractAndPersist: vi.fn(), isConfigured: vi.fn().mockResolvedValue(true) },
    });
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'task text',
      db: ENABLED_DB,
      timeoutMs: 30,
    });
    expect(block).toBe('');
  });

  it('returns empty when retrieval throws', async () => {
    setCompanyMemoryPorts({
      memoryRetriever: { retrieve: vi.fn().mockRejectedValue(new Error('backend down')) },
      runEndMemory: { extractAndPersist: vi.fn(), isConfigured: vi.fn().mockResolvedValue(true) },
    });
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'task text',
      db: ENABLED_DB,
    });
    expect(block).toBe('');
  });

  it('caps each item and the whole block', async () => {
    const huge = 'x'.repeat(5_000);
    setCompanyMemoryPorts(
      portsWith(
        Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `m${i}`, content: huge })),
      ),
    );
    const block = await fetchProjectMemoryBlock({
      projectId: 1,
      projectName: 'proj',
      taskText: 'task text',
      db: ENABLED_DB,
    });
    // Each item trimmed to ~1.2k → whole block stays under the 12k cap
    // (plus the fixed header).
    expect(block.length).toBeLessThan(13_000);
    expect(block).toContain('…');
  });
});
