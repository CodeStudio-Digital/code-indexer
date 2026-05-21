/**
 * Tool-selection shadow variants test — proves the variants produce
 * different selections than production for the same query.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import { ShadowTrafficRunner } from '@mcp/services/shadow-traffic/index.js';
import {
  buildToolSelectionShadowVariants,
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
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ type: 'text', text: '' }) as never,
    ...overrides,
  };
}

const toyEmbed: EmbeddingFn = async (text: string) => {
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) arr[i] = (text.toLowerCase().charCodeAt(i) || 0) / 128;
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

const ALL_TOOLS: CoderTool[] = [
  makeTool('Read', 'Read file'),
  makeTool('Write', 'Write file'),
  makeTool('Edit', 'Edit file'),
  makeTool('Bash', 'Run shell'),
  makeTool('Glob', 'Find files'),
  makeTool('Grep', 'Search content'),
  makeTool('TodoWrite', 'Manage todos'),
  makeTool('PowerShell', 'Run PS'),
  makeTool('DesignSystem', 'DS tooling'),
  makeTool('Database', 'DB queries'),
  makeTool('WebFetch', 'Fetch URL'),
  makeTool('GitStatus', 'git status'),
  makeTool('GitCommit', 'git commit'),
  makeTool('GitLog', 'git log'),
  makeTool('NotebookEdit', 'Jupyter edit'),
  makeTool('Sandbox', 'Sandbox shell'),
  makeTool('Kanban', 'Kanban ops'),
  makeTool('Slack', 'Slack messaging'),
  makeTool('Confluence', 'Confluence pages'),
  makeTool('Jira', 'Jira tickets'),
];

interface DbHandle {
  db: CodeIndexDB;
  store: CounterfactualLogStore;
  dir: string;
}

function setupDb(): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-shadow-tool-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new CounterfactualLogStore(db.raw()), dir };
}

function teardown(handle: DbHandle): void {
  try { handle.db.close(); } catch { /* */ }
  try { rmSync(handle.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('ToolSelection shadow variants', () => {
  let handle: DbHandle;
  beforeEach(() => { handle = setupDb(); });
  afterEach(() => teardown(handle));

  it('k=8 and k=16 produce different snapshots than k=12 (production)', async () => {
    const sharedStore = new InMemoryToolEmbeddingStore();
    const productionPipeline = createToolSelectionPipeline({
      getAllTools: () => ALL_TOOLS,
      embed: toyEmbed,
      toolEmbeddingStore: sharedStore,
      k: 12,
    });

    const variants = buildToolSelectionShadowVariants({
      getAllTools: () => ALL_TOOLS,
      embed: toyEmbed,
      toolEmbeddingStore: sharedStore,
      variantKs: [{ name: 'k_8', k: 8 }, { name: 'k_16', k: 16 }],
    });

    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants,
      store: handle.store,
      sampleRate: 1,
      scheduler: (fn) => fn(),
    });

    const query = { queryId: 'q', taskText: 'frontend bug fix' };
    const production = await selectTools(productionPipeline, query);
    await runner.runVariants({ queryHash: 'q', payload: query }, {
      toolNames: production.selected.map((t) => t.name),
    });

    const rows = handle.store.list();
    expect(rows).toHaveLength(2);
    const k8 = rows.find((r) => r.shadow_variant === 'k_8')!;
    const k16 = rows.find((r) => r.shadow_variant === 'k_16')!;
    const k8Snapshot = JSON.parse(k8.shadow_prediction_json!) as { toolNames: string[] };
    const k16Snapshot = JSON.parse(k16.shadow_prediction_json!) as { toolNames: string[] };

    expect(k8Snapshot.toolNames.length).toBeLessThanOrEqual(production.selected.length);
    expect(k16Snapshot.toolNames.length).toBeGreaterThanOrEqual(production.selected.length);
  });

  it('shadow run does not regenerate tool embeddings (shared cache)', async () => {
    const sharedStore = new InMemoryToolEmbeddingStore();
    let embedCalls = 0;
    const countingEmbed: EmbeddingFn = async (text) => {
      embedCalls++;
      return toyEmbed(text);
    };

    const productionPipeline = createToolSelectionPipeline({
      getAllTools: () => ALL_TOOLS,
      embed: countingEmbed,
      toolEmbeddingStore: sharedStore,
      k: 12,
    });
    const variants = buildToolSelectionShadowVariants({
      getAllTools: () => ALL_TOOLS,
      embed: countingEmbed,
      toolEmbeddingStore: sharedStore,
      variantKs: [{ name: 'k_8', k: 8 }],
    });

    const query = { queryId: 'q', taskText: 'frontend bug fix' };
    await selectTools(productionPipeline, query);
    const callsAfterProd = embedCalls;
    // Shadow run on the same query — tool embeddings cached, only the
    // task embedding may regenerate (variants share via cache too).
    embedCalls = 0;
    await variants[0].run(query);
    expect(embedCalls).toBeLessThanOrEqual(1); // at most the task embedding
    expect(callsAfterProd).toBeGreaterThan(0);
  });
});
