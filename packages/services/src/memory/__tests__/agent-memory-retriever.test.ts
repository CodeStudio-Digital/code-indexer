import { describe, expect, it, vi } from 'vitest';
import { AgentMemoryRetriever } from '../agent-memory-retriever.js';
import { recordMemoryAccess } from '../access-telemetry.js';

function fixture() {
  const rows = ['gotcha', 'convention', 'procedure', 'decision', 'architecture'].map((type, i) => ({
    id: i + 1, scope: 'project', project_id: 10, name: `memory-${i}`, type,
    content: 'Durable fact', importance: 0.7, created_at: '2026-11-04 00:00:00',
    archived_at: null, last_accessed_at: null, access_count: 0,
  }));
  const db = { getAgentMemoriesByIds: vi.fn((ids: number[]) => rows.filter(row => ids.includes(row.id))),
    bumpAgentMemoryAccess: vi.fn(), recordAgentMemoryEvent: vi.fn(),
    getAgentMemoryStaleBatch: vi.fn(() => new Map([[1, { stale: [], total: 0, unknown: 2 }]])),
    withBusyTimeout: vi.fn((_ms, write: () => void) => write()),
  };
  return { rows, db, retriever: new AgentMemoryRetriever({ search: async () => rows } as any, db as any, { topK: 5 }) };
}

describe('agent memory access receipts', () => {
  it('flags only memories with file references if verification fails', async () => {
    const { rows, db, retriever } = fixture();
    Object.assign(rows[0]!, { referenced_files: '["src/main.ts"]' });
    db.getAgentMemoryStaleBatch.mockImplementation(() => { throw new Error('index unavailable'); });
    const hits = await retriever.recall('project', 10, 'durable fact');
    expect(hits.find(hit => hit.id === '1')?.staleNote).toMatch(/could not be verified/);
    expect(hits.find(hit => hit.id === '2')?.staleNote).toBeUndefined();
  });
  it('does not mark candidates accessed and records only assembled IDs', async () => {
    const { db, retriever } = fixture();
    const candidates = await retriever.retrieve('project', 10, 'Find a durable fact');
    expect(candidates).toHaveLength(5);
    expect(db.bumpAgentMemoryAccess).not.toHaveBeenCalled();
    recordMemoryAccess(db as any, ['1', '2', '3', '1', '999'], 'injected');
    expect(db.bumpAgentMemoryAccess).toHaveBeenCalledExactlyOnceWith([1, 2, 3]);
    expect(db.recordAgentMemoryEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'injected', kept: 3 }));
    expect(candidates.find(row => row.id === '1')?.staleNote).toContain('2 file reference(s) could not be verified');
  });
  it('records a full explicit read separately and tolerates telemetry failure', async () => {
    const { db, retriever } = fixture();
    expect(await retriever.recall('project', 10, 'fact', 2)).toHaveLength(2);
    expect(db.recordAgentMemoryEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'explicit_read', kept: 2 }));
    db.withBusyTimeout.mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    expect(() => recordMemoryAccess(db as any, ['1'], 'injected')).not.toThrow();
  });
});
