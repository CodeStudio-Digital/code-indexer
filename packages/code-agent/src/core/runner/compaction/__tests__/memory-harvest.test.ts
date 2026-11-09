/**
 * Compaction-time memory harvest — pure input assembly + orchestration gates.
 * No sqlite, no LLM: store and runEndMemory are structural fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import {
  buildHarvestInput,
  harvestCompactionMemory,
  type HarvestInput,
  type HarvestSessionStore,
} from '../memory-harvest.js';
import { asSessionId, type SessionId } from '@mcp/session-storage';

const sessionId = (n: number): SessionId =>
  asSessionId(`00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);

function summaryFixture(over: Partial<CompactionSummaryV2> = {}): CompactionSummaryV2 {
  return {
    primary_request: 'fix the auth loop',
    key_concepts: [],
    files_and_code: [{ path: 'src/auth.ts', state: 'edited' }, { path: '', state: '' }],
    errors_and_fixes: ['401 loop -> refresh mutex'],
    problem_solving: '',
    all_user_messages: [],
    pending_tasks: [],
    current_work: '',
    next_step: '',
    ...over,
  } as CompactionSummaryV2;
}

function storeFixture(over: Partial<HarvestSessionStore> = {}): HarvestSessionStore & { marks: number[] } {
  const marks: number[] = [];
  return {
    marks,
    getCommandTrail: async () => [
      { command: 'pnpm test', isError: false },
      { command: 'pnpm bad', isError: true },
    ],
    didRunSucceed: async () => true,
    listSessionMemory: async () => [],
    setMemoryDistilledBoundary: async (
      _sid: SessionId,
      messageSeq: number,
    ) => {
      marks.push(messageSeq);
    },
    ...over,
  };
}

describe('buildHarvestInput', () => {
  it('assembles distiller input from the summary, filtering blanks and errors', () => {
    const input = buildHarvestInput({
      summary: summaryFixture(),
      trail: [{ command: 'pnpm test', isError: false }, { command: 'boom', isError: true }],
      succeeded: true,
      notes: [],
      trigger: 'compaction',
      sessionId: sessionId(9),
    });
    expect(input.primaryRequest).toBe('fix the auth loop');
    expect(input.filesTouched).toEqual(['src/auth.ts']);
    expect(input.errorsAndFixes).toEqual(['401 loop -> refresh mutex']);
    expect(input.toolTrail).toEqual(['pnpm test']); // error commands dropped
    expect(input.trigger).toBe('compaction');
    expect(input.sessionId).toBe(sessionId(9));
    expect(input.summary).toContain('primary_request');
  });

  it('drops the tool trail when the span did not succeed', () => {
    const input = buildHarvestInput({
      summary: summaryFixture(),
      trail: [{ command: 'pnpm test', isError: false }],
      succeeded: false,
      notes: [],
      trigger: 'idle',
      sessionId: sessionId(1),
    });
    expect(input.toolTrail).toEqual([]);
  });

  it('promotes only pinned or durable-kind notes, capped at 10', () => {
    const notes = [
      { title: 'gotcha A', body: 'b', kind: 'gotcha', pinned: false },
      { title: 'pinned fact', body: 'b', kind: 'fact', pinned: true },
      { title: 'loose fact', body: 'b', kind: 'fact', pinned: false }, // dropped
      ...Array.from({ length: 12 }, (_, i) => ({
        title: `decision ${i}`, body: 'b', kind: 'decision', pinned: false,
      })),
    ];
    const input = buildHarvestInput({
      summary: summaryFixture(),
      trail: [],
      succeeded: true,
      notes,
      trigger: 'compaction',
      sessionId: sessionId(1),
    });
    expect(input.sessionNotes).toHaveLength(10);
    expect(input.sessionNotes!.some((n) => n.title === 'loose fact')).toBe(false);
    expect(input.sessionNotes![1]).toMatchObject({ title: 'pinned fact', pinned: true });
  });
});

describe('harvestCompactionMemory', () => {
  const baseArgs = (over: Record<string, unknown> = {}) => ({
    store: storeFixture(),
    getMemoryEnabled: () => true,
    projectId: 1,
    projectName: 'proj',
    sessionId: sessionId(5),
    summary: summaryFixture(),
    boundaryId: 77,
    trigger: 'compaction' as const,
    ...over,
  });

  it('extracts and advances the high-water mark', async () => {
    const calls: HarvestInput[] = [];
    const store = storeFixture();
    await harvestCompactionMemory({
      ...baseArgs({ store }),
      runEndMemory: {
        extractAndPersist: async (_p, _n, input) => { calls.push(input); return { created: 1, merged: 0, skipped: 0 }; },
        isConfigured: async () => true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].trigger).toBe('compaction');
    expect(store.marks).toEqual([77]);
  });

  it('skips entirely when project memory is disabled', async () => {
    const store = storeFixture();
    let extracted = 0;
    await harvestCompactionMemory({
      ...baseArgs({ store, getMemoryEnabled: () => false }),
      runEndMemory: {
        extractAndPersist: async () => { extracted++; },
        isConfigured: async () => true,
      },
    });
    expect(extracted).toBe(0);
    expect(store.marks).toEqual([]); // untouched — nothing was covered
  });

  it.each([true, false])('leaves timeout pending and settles only a late success (hadError=%s)', async hadError => {
    vi.useFakeTimers();
    try {
      const store = storeFixture();
      let finish!: (value: { created: number; merged: number; skipped: number; hadError: boolean }) => void;
      const extraction = new Promise<{ created: number; merged: number; skipped: number; hadError: boolean }>(resolve => { finish = resolve; });
      const extractAndPersist = vi.fn(() => extraction);
      const args = { ...baseArgs({ store }), runEndMemory: { isConfigured: async () => true, extractAndPersist } };
      const first = harvestCompactionMemory(args);
      await vi.advanceTimersByTimeAsync(30_001);
      await first;
      expect(store.marks).toEqual([]);
      const second = harvestCompactionMemory(args);
      await vi.advanceTimersByTimeAsync(1);
      expect(extractAndPersist).toHaveBeenCalledOnce();
      finish({ created: hadError ? 0 : 1, merged: 0, skipped: 0, hadError });
      await second;
      expect(store.marks).toEqual(hadError ? [] : [77]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not consume a span without a persistence receipt', async () => {
    const store = storeFixture();
    await harvestCompactionMemory({ ...baseArgs({ store }), runEndMemory: {
      isConfigured: async () => true, extractAndPersist: async () => undefined,
    } });
    expect(store.marks).toEqual([]);
  });

  it('serializes boundaries, preserves a failed earlier span and skips committed replays', async () => {
    let boundary = 0;
    const store = storeFixture({ getMemoryDistilledBoundary: async () => boundary,
      setMemoryDistilledBoundary: async (_id, seq) => { boundary = Math.max(boundary, seq); } });
    let finish!: (value: { created: number; merged: number; skipped: number; hadError: boolean }) => void;
    const firstPass = new Promise<{ created: number; merged: number; skipped: number; hadError: boolean }>(resolve => { finish = resolve; });
    const extractAndPersist = vi.fn().mockReturnValueOnce(firstPass).mockResolvedValue({ created: 1, merged: 0, skipped: 0 });
    const common = { ...baseArgs({ store }), runEndMemory: { isConfigured: async () => true, extractAndPersist } };
    const first = harvestCompactionMemory({ ...common, sourceStartSeq: 1 });
    const second = harvestCompactionMemory({ ...common, sourceStartSeq: 78, boundaryId: 100 });
    await vi.waitFor(() => expect(extractAndPersist).toHaveBeenCalledTimes(1));
    finish({ created: 0, merged: 0, skipped: 0, hadError: true });
    await Promise.all([first, second]);
    expect(boundary).toBe(0); expect(extractAndPersist).toHaveBeenCalledTimes(1);
    boundary = 77; // Idle sweep has recovered the earlier contiguous span.
    await harvestCompactionMemory({ ...common, sourceStartSeq: 78, boundaryId: 100 });
    expect(boundary).toBe(100); expect(extractAndPersist).toHaveBeenCalledTimes(2);
    await harvestCompactionMemory({ ...common, sourceStartSeq: 78, boundaryId: 100 });
    expect(extractAndPersist).toHaveBeenCalledTimes(2);
  });

  it('skips when no distiller resolves (isConfigured=false)', async () => {
    let extracted = 0;
    await harvestCompactionMemory({
      ...baseArgs(),
      runEndMemory: {
        extractAndPersist: async () => { extracted++; },
        isConfigured: async () => false,
      },
    });
    expect(extracted).toBe(0);
  });

  it('swallows extract errors (never throws into the caller)', async () => {
    await expect(harvestCompactionMemory({
      ...baseArgs(),
      runEndMemory: {
        extractAndPersist: async () => { throw new Error('llm down'); },
        isConfigured: async () => true,
      },
    })).resolves.toBeUndefined();
  });
});
