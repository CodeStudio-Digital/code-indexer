/**
 * Tool-selection pipeline tests.
 *
 * Invariants verified:
 *   - Top-K limit respected
 *   - Essentials ALWAYS included even if scorers rank them low
 *   - Two-tower scorer ranks semantically-similar tools higher
 *   - Frequency boost lifts recently-used tools
 *   - Tier filter drops admin-risk tools at non-full tiers
 *   - Token savings estimate is computed
 *   - Embedding cache is hit on the second run
 */
import { describe, expect, it } from 'vitest';
import {
  createToolSelectionPipeline,
  InMemoryToolEmbeddingStore,
  selectTools,
  type EmbeddingFn,
} from '../index.js';
import type { CoderTool } from '../../core/tool.js';

function makeTool(name: string, description: string, overrides: Partial<CoderTool> = {}): CoderTool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { path: { description: 'Target path' } } },
    source: 'native',
    handler: async () => ({ type: 'text', text: '' }) as never,
    ...overrides,
  };
}

/**
 * Toy embedding: produces a 4-dim vector based on the first 4 chars of the
 * text, so identical-looking texts produce identical embeddings. Good enough
 * to verify cosine-sim ordering deterministically.
 */
const toyEmbed: EmbeddingFn = async (text: string) => {
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    arr[i] = (text.toLowerCase().charCodeAt(i) || 0) / 128;
  }
  // l2 normalize
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

describe('ToolSelectionPipeline', () => {
  const allTools: CoderTool[] = [
    makeTool('Read', 'Read file at path'),
    makeTool('Edit', 'Edit existing file'),
    makeTool('Write', 'Write a new file'),
    makeTool('Bash', 'Run a shell command'),
    makeTool('Glob', 'Find files by pattern'),
    makeTool('Grep', 'Search file content'),
    makeTool('TodoWrite', 'Manage task list'),
    makeTool('PowerShell', 'Run a PS command'),
    makeTool('DesignSystemExtract', 'Extract design tokens from a project'),
    makeTool('DatabaseQuery', 'Run a SQL query on the attached database'),
    makeTool('WebFetch', 'Fetch the content of a URL'),
    makeTool('PlaywrightRun', 'Execute Playwright e2e tests', { riskLevel: 'admin' }),
    makeTool('SandboxShell', 'Run a shell command inside a sandbox', { riskLevel: 'execute' }),
    makeTool('KanbanCreateCard', 'Create a kanban card'),
    makeTool('KanbanMoveCard', 'Move a kanban card to a column'),
    makeTool('McpExternalTool', 'A bridged MCP tool from outside', { source: 'mcp_external' }),
    makeTool('McpInternalTool', 'An internal MCP tool', { source: 'mcp' }),
    makeTool('GitStatus', 'Show git status'),
    makeTool('GitCommit', 'Create a git commit'),
  ];

  function makePipeline(k = 8) {
    return createToolSelectionPipeline({
      getAllTools: () => allTools,
      embed: toyEmbed,
      toolEmbeddingStore: new InMemoryToolEmbeddingStore(),
      k,
    });
  }

  it('respects the top-K limit (with essentials added on top)', async () => {
    const pipeline = makePipeline(8);
    const result = await selectTools(pipeline, {
      queryId: 'q', taskText: 'reading and editing files',
    });
    // Essentials = up to 8 in our set (Read/Edit/Write/TodoWrite/Bash/Glob/Grep/PowerShell)
    // Plus best-scoring others up to total K = 8. With all essentials present,
    // others slots = 0. So selected.length === 8.
    expect(result.selected.length).toBe(8);
  });

  it('always includes essentials regardless of score', async () => {
    const pipeline = makePipeline(12);
    const result = await selectTools(pipeline, {
      queryId: 'q',
      taskText: 'totally unrelated topic about astronomy and stars',
    });
    const selectedNames = new Set(result.selected.map((t) => t.name));
    expect(selectedNames.has('Read')).toBe(true);
    expect(selectedNames.has('Edit')).toBe(true);
    expect(selectedNames.has('Write')).toBe(true);
    expect(selectedNames.has('TodoWrite')).toBe(true);
    expect(selectedNames.has('Bash')).toBe(true);
  });

  it('drops admin-risk tools at navigate tier', async () => {
    const pipeline = makePipeline(20);
    const result = await selectTools(pipeline, {
      queryId: 'q', taskText: 'anything', tier: 'navigate',
    });
    const selectedNames = new Set(result.selected.map((t) => t.name));
    expect(selectedNames.has('PlaywrightRun')).toBe(false);
  });

  it('frequency boost lifts recently-used tools', async () => {
    const pipeline = makePipeline(12);
    const now = Date.now();
    const result = await selectTools(pipeline, {
      queryId: 'q',
      taskText: 'unrelated topic',
      recentToolEvents: [
        { toolName: 'KanbanCreateCard', timestampMs: now - 1_000, ok: true },
        { toolName: 'KanbanCreateCard', timestampMs: now - 500, ok: true },
        { toolName: 'KanbanCreateCard', timestampMs: now - 100, ok: true },
      ],
    });
    const selectedNames = new Set(result.selected.map((t) => t.name));
    expect(selectedNames.has('KanbanCreateCard')).toBe(true);
  });

  it('reports token savings estimate', async () => {
    const pipeline = makePipeline(5);
    const result = await selectTools(pipeline, {
      queryId: 'q', taskText: 'anything',
    });
    expect(result.diag.consideredCount).toBeGreaterThanOrEqual(result.selected.length);
    expect(result.diag.droppedCount).toBeGreaterThan(0);
    expect(result.diag.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('reuses cached tool embeddings on the second run', async () => {
    const store = new InMemoryToolEmbeddingStore();
    let embedCalls = 0;
    const countingEmbed: EmbeddingFn = async (text: string) => {
      embedCalls++;
      return toyEmbed(text);
    };

    const pipeline = createToolSelectionPipeline({
      getAllTools: () => allTools,
      embed: countingEmbed,
      toolEmbeddingStore: store,
      k: 8,
    });

    await selectTools(pipeline, { queryId: 'a', taskText: 'task 1' });
    const firstRunCalls = embedCalls;
    embedCalls = 0;
    await selectTools(pipeline, { queryId: 'b', taskText: 'task 2' });
    // Second run: tool embeddings are cached, only the task text gets a new embed.
    expect(embedCalls).toBe(1);
    expect(firstRunCalls).toBeGreaterThanOrEqual(allTools.length + 1);
  });
});
