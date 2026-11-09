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
  const readStateSync = vi.fn(() => entry.state!);
  const sessionStore = {
    ensureCatalog: vi.fn(async () => undefined),
    catalog: { list: vi.fn(() => [entry]) },
    repository: {
      readStateSync,
    },
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
  return {
    sessionStore,
    entry,
    readStateSync,
    setBoundary,
    resetAttempts,
  };
}

describe('memory sweeper relational writes', () => {
  it('skips a late host harvest even after its worker is no longer active', async () => {
    const id = sessionId(38);
    const { sessionStore } = shortSpanStore(id);
    const sweeper = startMemorySweeper({ sessionStore,
      db: { getProjectMemoryEnabled: () => true } as unknown as CodeIndexDB,
      runEndMemory: { hasPending: () => true, isConfigured: async () => true } as unknown as RunEndMemory,
      intervalMs: 60_000, idleAfterMs: 0, maxPerSweep: 1, isSessionActive: () => false });
    try {
      expect(await sweeper.runOnce()).toBe(0);
      expect(sessionStore.maxMessageSeq).not.toHaveBeenCalled();
      expect(sessionStore.listMessagesAfter).not.toHaveBeenCalled();
    } finally { sweeper.stop(); }
  });
  it('does not reopen an unchanged no-op conversation on every timer tick and balances diagnostics', async () => {
    const id = sessionId(39);
    const { sessionStore, entry } = shortSpanStore(id);
    vi.mocked(sessionStore.maxMessageSeq).mockResolvedValue(0);
    const enterBackgroundActivity = vi.fn(() => 71);
    const exitBackgroundActivity = vi.fn();
    const sweeper = startMemorySweeper({
      sessionStore,
      db: {
        getProjectMemoryEnabled: vi.fn(() => true),
      } as unknown as CodeIndexDB,
      runEndMemory: {
        isConfigured: vi.fn(async () => true),
      } as unknown as RunEndMemory,
      enterBackgroundActivity,
      exitBackgroundActivity,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
    });
    try {
      expect(await sweeper.runOnce()).toBe(0);
      expect(await sweeper.runOnce()).toBe(0);
      expect(sessionStore.maxMessageSeq).toHaveBeenCalledTimes(1);

      (entry.session as { updated_at: string }).updated_at =
        new Date(1).toISOString();
      expect(await sweeper.runOnce()).toBe(0);
      expect(sessionStore.maxMessageSeq).toHaveBeenCalledTimes(2);
    } finally {
      sweeper.stop();
    }

    expect(enterBackgroundActivity).toHaveBeenCalledTimes(3);
    expect(exitBackgroundActivity).toHaveBeenCalledTimes(3);
    expect(exitBackgroundActivity).toHaveBeenNthCalledWith(1, 71);
  });

  it('bounds candidate tail checks per sweep and rotates through the catalog', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => sessionId(100 + index));
    const { sessionStore } = shortSpanStore(ids[0]!);
    vi.mocked(sessionStore.catalog.list).mockReturnValue(ids.map(catalogEntry));
    vi.mocked(sessionStore.maxMessageSeq).mockResolvedValue(0);
    const sweeper = startMemorySweeper({
      sessionStore,
      db: {
        getProjectMemoryEnabled: vi.fn(() => true),
      } as unknown as CodeIndexDB,
      runEndMemory: {
        isConfigured: vi.fn(async () => true),
      } as unknown as RunEndMemory,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
      maxCandidatesInspected: 3,
    });
    try {
      expect(await sweeper.runOnce()).toBe(0);
      expect(await sweeper.runOnce()).toBe(0);
    } finally {
      sweeper.stop();
    }

    expect(sessionStore.maxMessageSeq).toHaveBeenCalledTimes(6);
    expect(vi.mocked(sessionStore.maxMessageSeq).mock.calls.flat()).toEqual(
      ids.slice(0, 6),
    );
  });

  it('does not distill an apparently idle session while its worker is alive', async () => {
    const id = sessionId(40);
    const { sessionStore, setBoundary } = shortSpanStore(id);
    const db = {
      getProjectMemoryEnabled: vi.fn(() => true),
    } as unknown as CodeIndexDB;
    const runEndMemory = {
      isConfigured: vi.fn(async () => true),
    } as unknown as RunEndMemory;
    const isSessionActive = vi.fn(() => true);

    const sweeper = startMemorySweeper({
      sessionStore,
      db,
      runEndMemory,
      isSessionActive,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
    });
    try {
      expect(await sweeper.runOnce()).toBe(0);
    } finally {
      sweeper.stop();
    }

    expect(isSessionActive).toHaveBeenCalledWith(id);
    expect(sessionStore.ensureCatalog).toHaveBeenCalledTimes(1);
    expect(sessionStore.repository.readStateSync).not.toHaveBeenCalled();
    expect(sessionStore.maxMessageSeq).not.toHaveBeenCalled();
    expect(runEndMemory.isConfigured).not.toHaveBeenCalled();
    expect(setBoundary).not.toHaveBeenCalled();
  });

  it('freshens only a cached non-idle state after its external worker exits', async () => {
    const id = sessionId(41);
    const { sessionStore, entry, readStateSync } = shortSpanStore(id);
    entry.state!.status = 'running';
    readStateSync.mockReturnValue({ ...entry.state!, status: 'idle' });
    const db = {
      getProjectMemoryEnabled: vi.fn(() => true),
    } as unknown as CodeIndexDB;
    const runEndMemory = {
      isConfigured: vi.fn(async () => false),
    } as unknown as RunEndMemory;

    const sweeper = startMemorySweeper({
      sessionStore,
      db,
      runEndMemory,
      intervalMs: 60_000,
      idleAfterMs: 0,
      maxPerSweep: 1,
    });
    try {
      expect(await sweeper.runOnce()).toBe(0);
    } finally {
      sweeper.stop();
    }

    expect(readStateSync).toHaveBeenCalledOnce();
    expect(sessionStore.maxMessageSeq).toHaveBeenCalledWith(id);
    expect(runEndMemory.isConfigured).toHaveBeenCalledOnce();
  });

  it('settles session state on filesystem and confines SQL queueing to project-memory hygiene', async () => {
    const id = sessionId(42);
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
    expect(sessionStore.repository.readStateSync).not.toHaveBeenCalled();
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
    const { sessionStore } = shortSpanStore(sessionId(43));
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
