import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { semanticIndexing227 } from '@mcp/store/migrations/227_semantic_indexing.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { projectJobsPage, currentProjectJobs } from '../semantic-job-queries.js';

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');

describe('worker project job queries', () => {
  it('returns exact continuation pages while preserving an older running marker separately', () => {
    const db = new Database(':memory:'); semanticIndexing227.up(db);
    const store = new SemanticStore(db);
    try {
      const running = store.createJob({ namespace: 'semantic:reindex:code:p7', kind: 'build' });
      store.updateJob(running.id, { status: 'running' });
      for (let i = 0; i < 205; i++) {
        const job = store.createJob({ namespace: 'code:p7', kind: 'delta', priority: 205 - i });
        store.updateJob(job.id, { status: 'completed' });
      }
      store.createJob({ namespace: 'code:p8', kind: 'build' });
      const input = { namespaces: ['code:p7', 'semantic:reindex:code:p7'], limit: 200 };
      const first = projectJobsPage(store, input);
      const rest = projectJobsPage(store, { ...input, beforeId: first.nextBeforeId! });
      expect(first.jobs).toHaveLength(200); expect(rest.jobs).toHaveLength(6);
      expect(rest.nextBeforeId).toBeNull();
      expect(new Set([...first.jobs, ...rest.jobs].map(row => row.id)).size).toBe(206);
      expect(currentProjectJobs(store, [{ projectId: 7, generationIds: [] }])[0]?.id).toBe(running.id);
      const scan = vi.spyOn(store, 'listJobs'); scan.mockClear();
      expect(() => projectJobsPage(store, { ...input, limit: 201 })).toThrow('page');
      expect(() => currentProjectJobs(store, Array(129).fill({ projectId: 7, generationIds: [] }))).toThrow('batch');
      expect(scan).not.toHaveBeenCalled();
    } finally { store.close(); db.close(); }
  });
});
