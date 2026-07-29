/**
 * FeedbackCollector tests — proves the observe → match → backfill flow
 * with the three pre-built matchers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import {
  FeedbackCollector,
  KanbanPriorityOutcomeMatcher,
  RolePipelineOutcomeMatcher,
  ToolSelectionOutcomeMatcher,
} from '../index.js';

interface H { db: CodeIndexDB; store: CounterfactualLogStore; dir: string }

function setup(): H {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-feedback-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new CounterfactualLogStore(db.raw()), dir };
}

function teardown(h: H): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('FeedbackCollector', () => {
  let h: H;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('backfills tool-selection rows whose query_hash matches', () => {
    const id = h.store.insert({
      pipeline_name: 'tool_selection',
      shadow_variant: 'k_8',
      query_hash: 'q1',
      production_choice: { toolNames: ['Read', 'Edit'] },
      shadow_prediction: { toolNames: ['Read'] },
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new ToolSelectionOutcomeMatcher()],
    });
    const n = collector.observe('tool_selection', {
      queryHash: 'q1',
      toolsCalled: ['Read', 'Bash'],
    });
    expect(n).toBe(1);
    const row = h.store.list({ pipelineName: 'tool_selection' })[0];
    expect(row.id).toBe(id);
    expect(JSON.parse(row.true_outcome_json!)).toEqual({ toolsCalled: ['Read', 'Bash'] });
  });

  it('ignores rows with a different query_hash', () => {
    h.store.insert({
      pipeline_name: 'tool_selection',
      shadow_variant: 'k_8',
      query_hash: 'q_other',
      production_choice: {},
      shadow_prediction: {},
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new ToolSelectionOutcomeMatcher()],
    });
    const n = collector.observe('tool_selection', {
      queryHash: 'q1',
      toolsCalled: [],
    });
    expect(n).toBe(0);
  });

  it('ignores stale pending rows past maxAgeMs', () => {
    h.store.insert({
      pipeline_name: 'tool_selection',
      shadow_variant: 'k_8',
      query_hash: 'q1',
      production_choice: {},
      shadow_prediction: {},
    });
    // Pretend the matcher's maxAge is 1ms and the row is way older.
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new ToolSelectionOutcomeMatcher(1)],
      now: () => Date.now() + 1_000_000,
    });
    const n = collector.observe('tool_selection', {
      queryHash: 'q1', toolsCalled: ['Read'],
    });
    expect(n).toBe(0);
  });

  it('returns 0 when no matcher is registered for the pipeline', () => {
    h.store.insert({
      pipeline_name: 'kanban_priority',
      shadow_variant: 'v',
      query_hash: 'q1',
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new ToolSelectionOutcomeMatcher()],
    });
    const n = collector.observe('kanban_priority', { queryHash: 'q1' });
    expect(n).toBe(0);
  });

  it('RolePipelineOutcomeMatcher records the spawned role', () => {
    h.store.insert({
      pipeline_name: 'role_pipeline',
      shadow_variant: 'v',
      query_hash: 'q_role',
      production_choice: { role: 'frontend' },
      shadow_prediction: { role: 'backend' },
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new RolePipelineOutcomeMatcher()],
    });
    const n = collector.observe('role_pipeline', {
      queryHash: 'q_role',
      roleSpawned: 'frontend',
      agentRunId: '50000000-0000-4000-8000-000000000042',
    });
    expect(n).toBe(1);
    const row = h.store.list({ pipelineName: 'role_pipeline' })[0];
    expect(JSON.parse(row.true_outcome_json!)).toEqual({
      roleSpawned: 'frontend',
      agentRunId: '50000000-0000-4000-8000-000000000042',
    });
    expect(row.outcome_confidence).toBe(1);
  });

  it('KanbanPriorityOutcomeMatcher records the moved card', () => {
    h.store.insert({
      pipeline_name: 'kanban_priority',
      shadow_variant: 'v',
      query_hash: 'q_kanban',
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [new KanbanPriorityOutcomeMatcher()],
    });
    collector.observe('kanban_priority', {
      queryHash: 'q_kanban',
      cardIdMovedToDone: 7,
      rankAmongCompleted: 1,
    });
    const row = h.store.list({ pipelineName: 'kanban_priority' })[0];
    expect(JSON.parse(row.true_outcome_json!)).toEqual({
      cardIdMovedToDone: 7,
      rankAmongCompleted: 1,
    });
  });

  it('stats() reports registered pipelines + cumulative backfills', () => {
    h.store.insert({
      pipeline_name: 'tool_selection',
      shadow_variant: 'v',
      query_hash: 'q1',
    });
    const collector = new FeedbackCollector({
      store: h.store,
      matchers: [
        new ToolSelectionOutcomeMatcher(),
        new RolePipelineOutcomeMatcher(),
      ],
    });
    collector.observe('tool_selection', { queryHash: 'q1', toolsCalled: ['Read'] });
    const stats = collector.stats();
    expect(stats.matchersCount).toBe(2);
    expect(stats.pipelines.sort()).toEqual(['role_pipeline', 'tool_selection']);
    expect(stats.totalBackfilled).toBe(1);
  });
});
