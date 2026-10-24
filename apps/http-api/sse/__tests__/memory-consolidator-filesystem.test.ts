import { describe, expect, it, vi } from 'vitest';
import {
  asSessionId,
  type CatalogEntry,
  type SessionId,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { SnapshotService } from '@mcp/services/services/snapshots.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
  projectIsIdleForConsolidation,
  startMemoryConsolidator,
} from '../memory-consolidator.js';

function sessionId(n: number): SessionId {
  return asSessionId(
    `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
  );
}

function entry(options: {
  id: number;
  owner: number | null;
  linked?: number[];
  status?: string;
  updatedAt: string;
}): CatalogEntry {
  const id = sessionId(options.id);
  const linked = options.linked ?? [];
  return {
    location: {
      session_id: id,
      scope:
        options.owner == null
          ? { kind: 'global' }
          : { kind: 'project', project_id: options.owner },
      session_root: 'C:\\sessions',
      bundle_path: `C:\\sessions\\${id}`,
    },
    session: {
      schema_version: 1,
      id,
      kind: options.owner == null ? 'global' : 'coder',
      created_at: options.updatedAt,
      updated_at: options.updatedAt,
      storage_scope:
        options.owner == null
          ? { kind: 'global' }
          : { kind: 'project', project_id: options.owner },
      owner_project_id: options.owner,
      linked_projects: linked.map((projectId) => ({
        project_id: projectId,
      })),
      parent_session_id: null,
      provider: 'test',
      model: 'test',
      title: 'test',
      favorite: false,
      archived_at: null,
      metadata: {},
    },
    state: {
      schema_version: 1,
      status: options.status ?? 'idle',
      updated_at: options.updatedAt,
      archived_at: null,
      goal: null,
      todos: [],
      permissions: {},
      tools: {},
      compaction: {},
      cursors: {},
      extra: {},
    },
  };
}

describe('filesystem idle gate for memory consolidation', () => {
  it('blocks owning and linked projects for running or recently touched sessions', () => {
    const now = Date.parse('2026-07-27T12:00:00.000Z');
    const entries = [
      entry({
        id: 1,
        owner: null,
        linked: [1, 2],
        status: 'running',
        updatedAt: '2026-07-27T10:00:00.000Z',
      }),
      entry({
        id: 2,
        owner: 3,
        updatedAt: '2026-07-27T11:55:00.000Z',
      }),
      entry({
        id: 3,
        owner: 4,
        updatedAt: '2026-07-27T10:00:00.000Z',
      }),
    ];
    const sessions = {
      catalog: { list: () => entries },
      repository: {
        readStateSync: vi.fn(),
      },
    } as unknown as Pick<FsSessionStore, 'catalog' | 'repository'>;

    expect(projectIsIdleForConsolidation(sessions, 1, 30 * 60_000, now))
      .toBe(false);
    expect(projectIsIdleForConsolidation(sessions, 2, 30 * 60_000, now))
      .toBe(false);
    expect(projectIsIdleForConsolidation(sessions, 3, 30 * 60_000, now))
      .toBe(false);
    expect(projectIsIdleForConsolidation(sessions, 4, 30 * 60_000, now))
      .toBe(true);
    expect(projectIsIdleForConsolidation(sessions, 99, 30 * 60_000, now))
      .toBe(true);
  });

  it('refreshes and filters the complete SQL candidate set before applying maxProjects', async () => {
    const now = new Date(0).toISOString();
    const active = entry({
      id: 1,
      owner: 1,
      status: 'running',
      updatedAt: now,
    });
    const refresh = vi.fn(async () => undefined);
    const sessionStore = {
      refresh,
      catalog: {
        list: () => [active],
        issues: [],
      },
      repository: {
        readStateSync: () => active.state!,
      },
    } as unknown as FsSessionStore;
    const listSnapshots = vi.fn(() => []);
    const logDistill = vi.fn();
    const db = {
      listConsolidationCandidates: vi.fn(() => [
        { project_id: 1, project_name: 'active' },
        { project_id: 3, project_name: 'first idle' },
        { project_id: 4, project_name: 'second idle' },
      ]),
      listSnapshots,
      getStaleSnapshotFilesBatch: vi.fn(() => new Map()),
      unionSnapshotFiles: vi.fn(),
      setSnapshotAccessStats: vi.fn(),
      insertMemoryDistillLog: logDistill,
    } as unknown as CodeIndexDB;
    const snapshotService = {
      hasEmbeddingBackend: () => false,
      update: vi.fn(),
      archive: vi.fn(),
    } as unknown as SnapshotService;
    const embeddingService = {
      embed: vi.fn(),
    } as unknown as EmbeddingService;

    const handle = startMemoryConsolidator({
      db,
      sessionStore,
      snapshotService,
      embeddingService,
      idleMs: 30 * 60_000,
      maxProjects: 1,
      armed: false,
    });
    try {
      const results = await handle.runOnce();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(db.listConsolidationCandidates).toHaveBeenCalledWith();
      expect(results.map((result) => result.projectId)).toEqual([3]);
      expect(listSnapshots).toHaveBeenCalledWith(3);
      expect(listSnapshots).not.toHaveBeenCalledWith(1);
      expect(logDistill).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });
});
