/**
 * applyToolSelection tests — verifies the safe fallback semantics and
 * the happy path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyToolSelection,
  createToolSelectionPipeline,
  InMemoryToolEmbeddingStore,
  type EmbeddingFn,
} from '../index.js';
import type { CoderTool } from '../../core/tool.js';

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
 * toolPolicy delta can change the ranking, making the assertion deterministic.
 */
const constEmbed: EmbeddingFn = async () => {
  const arr = new Float32Array(4);
  arr[0] = 1; // already unit length
  return arr;
};

function makeTool(name: string): CoderTool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ type: 'text', text: '' }) as never,
  };
}

const ALL_TOOLS: CoderTool[] = [
  ...['Read','Write','Edit','Bash','Glob','Grep','TodoWrite','PowerShell'].map(makeTool),
  ...['DesignSystem','Database','WebFetch','GitStatus','Kanban','Slack','Notion','Jira'].map(makeTool),
];

describe('applyToolSelection', () => {
  it('returns allTools when pipeline is undefined', async () => {
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix',
    });
    expect(out).toBe(ALL_TOOLS);
  });

  it('returns allTools when pipeline is null', async () => {
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix',
      pipeline: null,
    });
    expect(out).toBe(ALL_TOOLS);
  });

  it('returns allTools when taskText is too short', async () => {
    const pipeline = createToolSelectionPipeline({
      getAllTools: () => ALL_TOOLS,
      embed: toyEmbed,
      toolEmbeddingStore: new InMemoryToolEmbeddingStore(),
    });
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'hi',
      pipeline,
    });
    expect(out).toBe(ALL_TOOLS);
  });

  it('filters tools when pipeline is set + task is meaningful', async () => {
    const pipeline = createToolSelectionPipeline({
      getAllTools: () => ALL_TOOLS,
      embed: toyEmbed,
      toolEmbeddingStore: new InMemoryToolEmbeddingStore(),
      k: 10,
    });
    const onResult = vi.fn();
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend React bug fix in login flow',
      pipeline,
      onResult,
    });
    expect(out.length).toBeLessThan(ALL_TOOLS.length);
    expect(onResult).toHaveBeenCalled();
    const diag = onResult.mock.calls[0][0];
    expect(diag.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('forwards toolPolicy.preferred to the pipeline (lifts a preferred tool)', async () => {
    const pipeline = createToolSelectionPipeline({
      getAllTools: () => ALL_TOOLS,
      embed: constEmbed,
      toolEmbeddingStore: new InMemoryToolEmbeddingStore(),
      k: 9, // 8 essentials + exactly 1 slot for a non-essential
    });
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'meaningful task text here',
      pipeline,
      toolPolicy: { preferred: ['Jira'] },
    });
    const names = new Set(out.map((t) => t.name));
    // With all affinities tied, the +preferred nudge wins the single slot.
    expect(names.has('Jira')).toBe(true);
  });

  it('omitting toolPolicy vs passing an empty one yields identical selection', async () => {
    const mk = () =>
      createToolSelectionPipeline({
        getAllTools: () => ALL_TOOLS,
        embed: toyEmbed,
        toolEmbeddingStore: new InMemoryToolEmbeddingStore(),
        k: 12,
      });
    const base = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend React bug fix in login flow',
      pipeline: mk(),
    });
    const emptyPolicy = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend React bug fix in login flow',
      pipeline: mk(),
      toolPolicy: {},
    });
    expect(emptyPolicy.map((t) => t.name)).toEqual(base.map((t) => t.name));
  });

  it('falls back to allTools when pipeline throws', async () => {
    // A pipeline whose execute method throws (passing a malformed object).
    const out = await applyToolSelection({
      allTools: ALL_TOOLS,
      taskText: 'frontend bug fix',
      pipeline: {
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => { throw new Error('boom'); },
      } as never,
    });
    expect(out).toBe(ALL_TOOLS);
  });
});
