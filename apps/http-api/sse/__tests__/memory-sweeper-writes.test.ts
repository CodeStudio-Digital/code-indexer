import { describe, expect, it, vi } from 'vitest';
import { startMemorySweeper } from '../memory-sweeper.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';

describe('memory sweeper relational writes', () => {
  it('queues atomic settlement, scope hygiene, and event pruning', async () => {
    const setBoundary = vi.fn();
    const resetAttempts = vi.fn();
    const sessionStore = {
      listMemoryDistillPending: vi.fn(() => [{
        session_id: 41,
        project_id: 7,
        provider: 'test',
        model: 'test',
        distilled_mark: 0,
        attempts: 0,
      }]),
      listMessagesAfter: vi.fn(() => ({
        messages: [{ id: 9 }],
        maxId: 9,
      })),
      setMemoryDistilledBoundary: setBoundary,
      resetMemoryDistillAttempts: resetAttempts,
    } as unknown as SessionStore;

    const transaction = vi.fn(<T>(operation: () => T): T => operation());
    const pruneAgentMemoryEvents = vi.fn(() => 0);
    const db = {
      transaction,
      hasAgentMemoryHygieneCandidates: vi.fn(() => true),
      consolidateAgentMemory: vi.fn(() => ({ archived: 0 })),
      decayColdAgentMemoryNotes: vi.fn(() => 0),
      pruneAgentMemoryEvents,
    } as unknown as CodeIndexDB;

    const runRelationalWrite = vi.fn(async <T>(operation: () => T): Promise<T> => operation());
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

    expect(setBoundary).toHaveBeenCalledWith(41, 9);
    expect(resetAttempts).toHaveBeenCalledWith(41);
    expect(transaction).toHaveBeenCalledOnce();
    expect(runScopeMutationAsync).toHaveBeenCalledTimes(2);
    expect(runScopeMutationAsync.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['project', 7],
      ['user', 0],
    ]);
    expect(pruneAgentMemoryEvents).toHaveBeenCalledOnce();
    // One queued transaction settles the span; a second queued write prunes
    // telemetry. Scope mutations use the same queue inside the real service.
    expect(runRelationalWrite).toHaveBeenCalledTimes(2);
  });

  it('skips semantic scope mutations when hygiene preflight is a no-op', async () => {
    const sessionStore = {
      listMemoryDistillPending: vi.fn(() => [{
        session_id: 42,
        project_id: 7,
        provider: 'test',
        model: 'test',
        distilled_mark: 0,
        attempts: 0,
      }]),
      listMessagesAfter: vi.fn(() => ({ messages: [{ id: 10 }], maxId: 10 })),
      setMemoryDistilledBoundary: vi.fn(),
      resetMemoryDistillAttempts: vi.fn(),
    } as unknown as SessionStore;
    const db = {
      transaction: <T>(operation: () => T): T => operation(),
      hasAgentMemoryHygieneCandidates: vi.fn(() => false),
      consolidateAgentMemory: vi.fn(() => ({ archived: 0 })),
      decayColdAgentMemoryNotes: vi.fn(() => 0),
      pruneAgentMemoryEvents: vi.fn(() => 0),
    } as unknown as CodeIndexDB;
    const runScopeMutationAsync = vi.fn();
    const agentMemoryService = {
      runRelationalWrite: async <T>(operation: () => T): Promise<T> => operation(),
      runScopeMutationAsync,
    } as unknown as AgentMemoryService;
    const sweeper = startMemorySweeper({
      sessionStore,
      db,
      runEndMemory: { isConfigured: async () => true } as unknown as RunEndMemory,
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
