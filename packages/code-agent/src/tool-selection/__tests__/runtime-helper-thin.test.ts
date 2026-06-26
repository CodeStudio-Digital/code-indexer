/**
 * applyToolSelectionThin tests — verifies the stripped-tool path works
 * end-to-end without needing the full pipeline + CoderTool[] shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyToolSelectionThin,
  clearTaskEmbeddingCacheForTests,
  InMemoryToolEmbeddingStore,
  type EmbeddingFn,
  type ThinTool,
} from '../index.js';

beforeEach(() => {
  // Module-level task embedding cache leaks across tests; reset.
  clearTaskEmbeddingCacheForTests();
});

const toyEmbed: EmbeddingFn = async (text: string) => {
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) arr[i] = (text.toLowerCase().charCodeAt(i) || 0) / 128;
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

/**
 * Constant unit embedding — every text maps to the same vector, so all
 * candidates tie on taskAffinity. This isolates the policy nudge: only the
 * toolPolicy delta can change the ranking of non-essentials.
 */
const constEmbed: EmbeddingFn = async () => {
  const arr = new Float32Array(4);
  arr[0] = 1;
  return arr;
};

function makeTool(name: string, desc?: string): ThinTool {
  return { name, description: desc ?? `${name} description`, parameters: { type: 'object', properties: {} } };
}

const ALL_TOOLS: ThinTool[] = [
  ...['Read','Write','Edit','Bash','Glob','Grep','TodoWrite','PowerShell'].map((n) => makeTool(n)),
  ...['DesignSystem','Database','WebFetch','GitStatus','Kanban','Slack','Notion','Jira','PlaywrightRun','Sandbox'].map((n) => makeTool(n)),
];

describe('applyToolSelectionThin', () => {
  it('returns allTools unchanged when task text is too short', async () => {
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'hi',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
    });
    expect(out).toBe(ALL_TOOLS);
  });

  it('returns allTools unchanged when count <= k', async () => {
    const small = ALL_TOOLS.slice(0, 5);
    const out = await applyToolSelectionThin({
      allTools: small,
      taskText: 'frontend bug fix in login flow',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
    });
    expect(out).toBe(small);
  });

  it('filters and always includes essentials', async () => {
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'totally unrelated topic about astronomy and stars',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
    });
    expect(out.length).toBeLessThanOrEqual(10 + 8); // essentials + slots up to k
    const names = new Set(out.map((t) => t.name));
    // Core essentials must be present.
    for (const ess of ['Read', 'Write', 'Edit', 'Bash', 'TodoWrite']) {
      expect(names.has(ess)).toBe(true);
    }
  });

  it('fires onResult with token-savings estimate', async () => {
    const onResult = vi.fn();
    await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix in login flow',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
      onResult,
    });
    expect(onResult).toHaveBeenCalled();
    const diag = onResult.mock.calls[0][0];
    expect(diag.consideredCount).toBe(ALL_TOOLS.length);
    expect(diag.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    expect(diag.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses cached embeddings on second call', async () => {
    const store = new InMemoryToolEmbeddingStore();
    let embedCalls = 0;
    const countingEmbed: EmbeddingFn = async (text) => {
      embedCalls++;
      return toyEmbed(text);
    };
    await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'first task',
      embed: countingEmbed,
      embeddingStore: store,
      k: 10,
    });
    const callsAfterFirst = embedCalls;
    embedCalls = 0;
    await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'second task',
      embed: countingEmbed,
      embeddingStore: store,
      k: 10,
    });
    // Second run: only the task embedding is fresh; tool embeddings cached.
    expect(embedCalls).toBe(1);
    expect(callsAfterFirst).toBeGreaterThan(1);
  });

  it('falls back to allTools when embed throws', async () => {
    const failingEmbed: EmbeddingFn = async () => {
      throw new Error('boom');
    };
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix in login flow',
      embed: failingEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
    });
    expect(out).toBe(ALL_TOOLS);
  });

  it('frequency-boost lifts recently-used non-essential tools', async () => {
    const now = Date.now();
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'unrelated topic',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
      recentToolCalls: [
        { name: 'Kanban', timestampMs: now - 1000 },
        { name: 'Kanban', timestampMs: now - 500 },
        { name: 'Kanban', timestampMs: now - 100 },
        { name: 'Kanban', timestampMs: now - 50 },
        { name: 'Kanban', timestampMs: now - 10 },
      ],
    });
    const names = new Set(out.map((t) => t.name));
    expect(names.has('Kanban')).toBe(true);
  });

  // ── toolPolicy nudge (Agent Decision Engine wiring) ──────────────────
  it('toolPolicy.preferred lifts a non-essential tool into the single slot', async () => {
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'meaningful task text here',
      embed: constEmbed, // all tie on affinity → only the policy delta matters
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 9, // 8 essentials + exactly 1 non-essential slot
      toolPolicy: { preferred: ['Jira'] },
    });
    expect(new Set(out.map((t) => t.name)).has('Jira')).toBe(true);
  });

  it('toolPolicy.discouraged sinks a tool affinity ties would otherwise pick', async () => {
    const baseline = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'meaningful task text here',
      embed: constEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 9,
    });
    // With ties broken by original order, the first non-essential wins the slot.
    expect(new Set(baseline.map((t) => t.name)).has('DesignSystem')).toBe(true);

    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'meaningful task text here',
      embed: constEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 9,
      toolPolicy: { discouraged: ['DesignSystem'] },
    });
    expect(new Set(out.map((t) => t.name)).has('DesignSystem')).toBe(false);
  });

  it('matches policy names canonically (snake_case engine name ↔ PascalCase candidate)', async () => {
    const out = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'meaningful task text here',
      embed: constEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 9,
      toolPolicy: { preferred: ['web_fetch'] }, // candidate name is 'WebFetch'
    });
    expect(new Set(out.map((t) => t.name)).has('WebFetch')).toBe(true);
  });

  it('omitting toolPolicy vs passing an empty one yields identical selection', async () => {
    const base = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix in login flow',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
    });
    const empty = await applyToolSelectionThin({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix in login flow',
      embed: toyEmbed,
      embeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
      toolPolicy: {},
    });
    expect(empty.map((t) => t.name)).toEqual(base.map((t) => t.name));
  });

  // ── Task embedding cache (A4) ────────────────────────────────────────
  describe('task embedding cache', () => {
    it('first call misses → calls embed for taskText; second call with same text hits', async () => {
      const store = new InMemoryToolEmbeddingStore();
      let embedCalls: string[] = [];
      const trackingEmbed: EmbeddingFn = async (text: string) => {
        embedCalls.push(text);
        return toyEmbed(text);
      };
      const onResult = vi.fn();
      const taskText = 'how does the indexer chunk symbols across languages';

      await applyToolSelectionThin({
        allTools: ALL_TOOLS,
        taskText,
        embed: trackingEmbed,
        embeddingStore: store,
        k: 10,
        onResult,
      });
      const firstTaskCalls = embedCalls.filter((t) => t === taskText).length;
      expect(firstTaskCalls).toBe(1);
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: false }));

      onResult.mockClear();
      embedCalls = [];

      await applyToolSelectionThin({
        allTools: ALL_TOOLS,
        taskText,
        embed: trackingEmbed,
        embeddingStore: store,
        k: 10,
        onResult,
      });
      // The second call must NOT have embedded the same taskText again.
      const secondTaskCalls = embedCalls.filter((t) => t === taskText).length;
      expect(secondTaskCalls).toBe(0);
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: true }));
    });

    it('different taskText misses independently', async () => {
      const store = new InMemoryToolEmbeddingStore();
      const taskKeys: string[] = [];
      const trackingEmbed: EmbeddingFn = async (text: string) => {
        taskKeys.push(text);
        return toyEmbed(text);
      };
      const onResult = vi.fn();

      await applyToolSelectionThin({
        allTools: ALL_TOOLS,
        taskText: 'task one — indexer chunking',
        embed: trackingEmbed,
        embeddingStore: store,
        k: 10,
        onResult,
      });
      expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: false }));

      await applyToolSelectionThin({
        allTools: ALL_TOOLS,
        taskText: 'task two — completely different intent',
        embed: trackingEmbed,
        embeddingStore: store,
        k: 10,
        onResult,
      });
      expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: false }));
    });

    it('cache hit returns the same embedding vector', async () => {
      const store = new InMemoryToolEmbeddingStore();
      const onFirst = vi.fn();
      const onSecond = vi.fn();
      const taskText = 'stable text for cache hit identity check';
      const cosineProbe: ThinTool = { name: 'CosineProbe', description: 'probe', parameters: { type: 'object', properties: {} } };
      const toolList = [...ALL_TOOLS, cosineProbe];

      await applyToolSelectionThin({
        allTools: toolList,
        taskText,
        embed: toyEmbed,
        embeddingStore: store,
        k: 10,
        onResult: onFirst,
      });
      await applyToolSelectionThin({
        allTools: toolList,
        taskText,
        embed: toyEmbed,
        embeddingStore: store,
        k: 10,
        onResult: onSecond,
      });
      // First miss, then hit.
      expect(onFirst).toHaveBeenCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: false }));
      expect(onSecond).toHaveBeenCalledWith(expect.objectContaining({ taskEmbeddingCacheHit: true }));
    });
  });
});
