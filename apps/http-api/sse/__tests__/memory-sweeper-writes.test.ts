import { describe, expect, it, vi } from 'vitest';
import {
  startMemorySweeper,
  type MemorySweeperSessionStore,
} from '../memory-sweeper.js';
import {
  asSessionId,
  type CatalogEntry,
  type SessionId,
} from '@mcp/session-storage';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';

function sessionId(n: number): SessionId {
  return asSessionId(
    `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
  );
}

function catalogEntry(id: SessionId): CatalogEntry {
  const updatedAt = new Date(0).toISOString();
  return {
    location: {
      session_id: id,
      scope: { kind: 'project', project_id: 7 },
      session_root: 'C:\\test\\session',
      bundle_path: `C:\\test\\session\\${id}`,
    },
    session: {
      schema_version: 1,
      id,
      kind: 'coder',
      created_at: updatedAt,
      updated_at: updatedAt,
      storage_scope: { kind: 'project', project_id: 7 },
      owner_project_id: 7,
      linked_projects: [],
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
      status: 'idle',
      updated_at: updatedAt,
      archived_at: null,
      goal: null,
      todos: [],
      permissions: {},
      tools: {},
      compaction: {},
      cursors: {},
      extra: {
        runtime: {
          memory_distilled_seq: 0,
          memory_distill_attempts: 0,
        },
      },
    },
  };
}

function shortSpanStore(id: SessionId) {
  const setBoundary = vi.fn(async () => undefined);
  const resetAttempts = vi.fn(async () => undefined);
  const entry = catalogEntry(id);
  const sessionStore = {
    refresh: vi.fn(async () => undefined),
    catalog: { list: vi.fn(() => [entry]) },
    repository: { readStateSync: vi.fn(() => entry.state!) },
    maxMessageSeq: vi.fn(async () => 9),
    listMessagesAfter: vi.fn(async () => ({
      messages: [{ role: 'user', content: 'one' }],
      maxSeq: 9,
    })),
    setMemoryDistilledBoundary: setBoundary,
    resetMemoryDistillAttempts: resetAttempts,
    bumpMemoryDistillAttempts: vi.fn(async () => undefined),
    appendSessionEvent: vi.fn(async () => undefined),
    getCommandTrail: vi.fn(async () => []),
    didRunSucceed: vi.fn(async () => false),
    listSessionMemory: vi.fn(async () => []),
  } as unknown as MemorySweeperSessionStore;
  return { sessionStore, setBoundary, resetAttempts };
}

describe('memory sweeper relational writes', () => {
  it('settles session state on filesystem and confines SQL queueing to project-memory hygiene', async () => {
    const id = sessionId(41);
    const { sessionStore, setBoundary, resetAttempts } =
      shortSpanStore(id);

    const transaction = vi.fn(<T>(operation: () => T): T => operation());
    const pruneAgentMemoryEvents = vi.fn(() => 0);
    const db = {
      transaction,
      getProjectMemoryEnabled: vi.fn(() => true),
      hasAgentMemoryHygieneCandidates: vi.fn(() => true),
      consolidateAgentMemory: vi.fn(() => ({ archived: 0 })),
      decayColdAgentMemoryNotes: vi.fn(() => 0),
      pruneAgentMemoryEvents,
    } as unknown as CodeIndexDB;

    const runRelationalWrite = vi.fn(
      async <T>(operation: () => T): Promise<T> => operation(),
    );
    const runScopeMutationAsync = vi.fn(async <T>(
      _scope: string,
      _projectId: number,
      operation: () => T,
    ): Promise<T> => operation());
    const agentMemoryService = {
      runRelationalWrite,
      runScopeMutationAsync,
    } as unknown as AgentMemoryService;
    const runEndMemory = {
      isConfigured: vi.fn(async () => true),
    } as unknown as RunEndMemory;

    const sweeper = startMemorySweeper({
      sessionStore,
      db,
      runEndMemory,
      agentMemoryService,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
    });
    try {
      expect(await sweeper.runOnce()).toBe(0);
    } finally {
      sweeper.stop();
    }

    expect(setBoundary).toHaveBeenCalledWith(id, 9);
    expect(resetAttempts).toHaveBeenCalledWith(id);
    expect(transaction).not.toHaveBeenCalled();
    expect(runScopeMutationAsync).toHaveBeenCalledTimes(2);
    expect(runScopeMutationAsync.mock.calls.map((call) => call.slice(0, 2)))
      .toEqual([
        ['project', 7],
        ['user', 0],
      ]);
    expect(pruneAgentMemoryEvents).toHaveBeenCalledOnce();
    expect(runRelationalWrite).toHaveBeenCalledOnce();
  });

  it('skips semantic scope mutations when hygiene preflight is a no-op', async () => {
    const { sessionStore } = shortSpanStore(sessionId(42));
    const db = {
      transaction: <T>(operation: () => T): T => operation(),
      getProjectMemoryEnabled: vi.fn(() => true),
      hasAgentMemoryHygieneCandidates: vi.fn(() => false),
      consolidateAgentMemory: vi.fn(() => ({ archived: 0 })),
      decayColdAgentMemoryNotes: vi.fn(() => 0),
      pruneAgentMemoryEvents: vi.fn(() => 0),
    } as unknown as CodeIndexDB;
    const runScopeMutationAsync = vi.fn();
    const agentMemoryService = {
      runRelationalWrite: async <T>(
        operation: () => T,
      ): Promise<T> => operation(),
      runScopeMutationAsync,
    } as unknown as AgentMemoryService;
    const sweeper = startMemorySweeper({
      sessionStore,
      db,
      runEndMemory: {
        isConfigured: async () => true,
      } as unknown as RunEndMemory,
      agentMemoryService,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
    });
    try {
      await sweeper.runOnce();
    } finally {
      sweeper.stop();
    }

    expect(db.hasAgentMemoryHygieneCandidates).toHaveBeenCalledTimes(2);
    expect(runScopeMutationAsync).not.toHaveBeenCalled();
    expect(db.consolidateAgentMemory).not.toHaveBeenCalled();
    expect(db.decayColdAgentMemoryNotes).not.toHaveBeenCalled();
  });
});
