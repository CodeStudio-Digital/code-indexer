/**
 * Compaction-time memory harvest — pure input assembly + orchestration gates.
 * No sqlite, no LLM: store and runEndMemory are structural fakes.
 */
import { describe, it, expect } from 'vitest';
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import {
  buildHarvestInput,
  harvestCompactionMemory,
  type HarvestInput,
  type HarvestSessionStore,
} from '../memory-harvest.js';

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
    getCommandTrail: () => [
      { command: 'pnpm test', isError: false },
      { command: 'pnpm bad', isError: true },
    ],
    didRunSucceed: () => true,
    listSessionMemory: () => [],
    setMemoryDistilledBoundary: (_sid: number, messageId: number) => { marks.push(messageId); },
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
      sessionId: 9,
    });
    expect(input.primaryRequest).toBe('fix the auth loop');
    expect(input.filesTouched).toEqual(['src/auth.ts']);
    expect(input.errorsAndFixes).toEqual(['401 loop -> refresh mutex']);
    expect(input.toolTrail).toEqual(['pnpm test']); // error commands dropped
    expect(input.trigger).toBe('compaction');
    expect(input.sessionId).toBe(9);
    expect(input.summary).toContain('primary_request');
  });

  it('drops the tool trail when the span did not succeed', () => {
    const input = buildHarvestInput({
      summary: summaryFixture(),
      trail: [{ command: 'pnpm test', isError: false }],
      succeeded: false,
      notes: [],
      trigger: 'idle',
      sessionId: 1,
    });
    expect(input.toolTrail).toEqual([]);
  });

  it('promotes only pinned or durable-kind notes, capped at 10', () => {
    const notes = [
      { title: 'gotcha A', body: 'b', kind: 'gotcha', pinned: 0 },
      { title: 'pinned fact', body: 'b', kind: 'fact', pinned: 1 },
      { title: 'loose fact', body: 'b', kind: 'fact', pinned: 0 }, // dropped
      ...Array.from({ length: 12 }, (_, i) => ({
        title: `decision ${i}`, body: 'b', kind: 'decision', pinned: 0,
      })),
    ];
    const input = buildHarvestInput({
      summary: summaryFixture(),
      trail: [],
      succeeded: true,
      notes,
      trigger: 'compaction',
      sessionId: 1,
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
    sessionId: 5,
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
        extractAndPersist: async (_p, _n, input) => { calls.push(input); },
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
