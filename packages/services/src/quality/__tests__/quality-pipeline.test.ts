/**
 * QualityClassifierPipeline tests — uses a real temp-file SQLite via
 * CodeIndexDB (so all migrations + initSchema run) and a stub chatFn so
 * no real LLM call is made.
 *
 * Invariants verified:
 *   - All classifiers run in parallel (no order dependence)
 *   - One classifier failing doesn't stop the others
 *   - The worstVerdict aggregation picks the highest-severity outcome
 *   - Persistence: rows are written to quality_classifications
 *   - Telemetry: one aggregated event per call
 *   - JSON parsing handles markdown-wrapped JSON
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { CodeIndexDB } from '@mcp/store/db.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PipelineProviderResolver } from '../../pipelines/index.js';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import {
  OffTopicClassifier,
  CompletenessClassifier,
  CodeQualityClassifier,
  PolicyClassifier,
  ToolMisuseClassifier,
  CombinedQualityClassifier,
  QualityClassifierPipeline,
  type ChatMessage,
} from '../index.js';

type RawDb = InstanceType<typeof DatabaseConstructor>;

interface DbHandle {
  db: CodeIndexDB;
  raw: RawDb;
  dir: string;
}

function setupDb(): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-quality-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, raw: db.raw(), dir };
}

function teardown(handle: DbHandle): void {
  try { handle.db.close(); } catch { /* */ }
  try { rmSync(handle.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seedProviderAndBindings(raw: RawDb): void {
  raw.prepare(
    `INSERT INTO provider_configs (id, name, kind, base_url, api_key, auth_mode, enabled, use_for_agent, use_for_coder, is_default)
     VALUES ('cf-1', 'OpenAI test', 'openai', 'https://api.openai.com/v1', 'tok', 'api_key', 1, 1, 1, 1)`,
  ).run();
  const bindings = new PipelineProviderBindingsStore(raw);
  for (const pipelineName of [
    'quality_off_topic',
    'quality_completeness',
    'quality_code',
    'quality_policy',
    'quality_tool_misuse',
  ]) {
    bindings.upsert({
      pipeline_name: pipelineName,
      binding_role: 'classifier',
      provider_id: 'cf-1',
      model_id: 'gpt-test',
      scope_type: 'global',
      scope_id: null,
      config: { temperature: 0.0, max_tokens: 256 },
    });
  }
}

function makeStubChat(scenario: Record<string, { verdict: string; reason?: string }>) {
  return async (
    _binding: import('../../pipelines/index.js').ResolvedBinding,
    messages: ChatMessage[],
  ): Promise<{ content: string; latencyMs: number }> => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    let key = 'default';
    if (sys.includes('stayed on task'))          key = 'off_topic';
    else if (sys.includes('completed'))          key = 'completeness';
    else if (sys.includes('code an AI agent'))   key = 'code_quality';
    else if (sys.includes('policy violations'))  key = 'policy';
    else if (sys.includes('tool-call sequences'))key = 'tool_misuse';
    const result = scenario[key] ?? { verdict: 'ok' };
    return {
      content: JSON.stringify({ verdict: result.verdict, confidence: 0.9, reason: result.reason ?? 'stubbed' }),
      latencyMs: 5,
    };
  };
}

describe('QualityClassifierPipeline', () => {
  let handle: DbHandle;
  beforeEach(() => { handle = setupDb(); });
  afterEach(() => teardown(handle));

  it('persists one terminal request as four dimensional rows with one assessment id', async () => {
    seedProviderAndBindings(handle.raw);
    const resolver = new PipelineProviderResolver(
      new PipelineProviderBindingsStore(handle.raw),
      new ProviderStore(handle.raw),
    );
    const chatFn = async () => ({
      content: JSON.stringify({
        verdict: 'warn',
        confidence: 0.8,
        reason: 'one dimension needs review',
        dimensions: {
          delivery_relevance: { verdict: 'ok', confidence: 0.9, reason: 'relevant' },
          delivery_completeness: { verdict: 'warn', confidence: 0.8, reason: 'partial' },
          evidence_alignment: { verdict: 'ok', confidence: 0.95, reason: 'supported' },
        },
      }),
      latencyMs: 7,
      tokensIn: 120,
      tokensOut: 40,
    });
    const store = new QualityClassificationStore(handle.raw);
    const pipeline = new QualityClassifierPipeline({
      classifiers: [new CombinedQualityClassifier(resolver, {
        chatFn,
        singleAttempt: true,
        retry: { maxRetries: 0 },
      })],
      store,
      maxConcurrency: 1,
    });

    const result = await pipeline.classify({
      sessionId: 1,
      roundMessageId: 81,
      taskText: 'Implement the change',
      outputText: 'Implemented and tested.',
      stopReason: 'completed',
      changedFiles: ['src/a.ts'],
      toolSummary: { total: 3, success: 3, error: 0, timeout: 0, refusal: 0, tools: [] },
      validationSignals: ['vitest run'],
    });
    expect(result.verdicts).toHaveLength(4);
    const rows = store.listRecent({ scope: 'run_final' });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.assessment_id))).toEqual(new Set([result.assessmentId]));
    expect(new Set(rows.map((row) => row.classifier_name))).toEqual(new Set([
      'delivery_overall',
      'delivery_relevance',
      'delivery_completeness',
      'evidence_alignment',
    ]));
    expect(rows.every((row) => row.round_message_id === 81 && row.source === 'terminal_llm')).toBe(true);
    expect(rows.reduce((sum, row) => sum + (row.tokens_in ?? 0), 0)).toBe(120);
    expect(store.overview()).toMatchObject({
      completedTasks: 1,
      assessments: 1,
      llmRequests: 1,
      tokensIn: 120,
      tokensOut: 40,
      infrastructureFailures: 0,
    });
  });

  it('counts parser failure as infrastructure, not delivery quality', async () => {
    seedProviderAndBindings(handle.raw);
    const store = new QualityClassificationStore(handle.raw);
    const resolver = new PipelineProviderResolver(
      new PipelineProviderBindingsStore(handle.raw),
      new ProviderStore(handle.raw),
    );
    const pipeline = new QualityClassifierPipeline({
      classifiers: [new CombinedQualityClassifier(resolver, {
        chatFn: async () => ({ content: 'not-json', latencyMs: 3, tokensIn: 10, tokensOut: 2 }),
        singleAttempt: true,
        retry: { maxRetries: 0 },
      })],
      store,
    });

    await pipeline.classify({
      roundMessageId: 82,
      taskText: 'task',
      outputText: 'final',
      stopReason: 'completed',
    });

    const rows = store.listRecent({ scope: 'run_final' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'error', system_error: 1, source: 'terminal_llm' });
    expect(store.verdictDistribution({ scope: 'run_final', excludeSystemErrors: true })).toEqual([]);
    expect(store.overview()).toMatchObject({
      completedTasks: 1,
      assessments: 1,
      llmRequests: 1,
      infrastructureFailures: 1,
    });
  });

  it('runs all 5 classifiers in parallel and aggregates verdicts', async () => {
    seedProviderAndBindings(handle.raw);
    const providerStore = new ProviderStore(handle.raw);
    const bindings = new PipelineProviderBindingsStore(handle.raw);
    const resolver = new PipelineProviderResolver(bindings, providerStore);

    const chatFn = makeStubChat({
      off_topic:    { verdict: 'ok' },
      completeness: { verdict: 'warn' },
      code_quality: { verdict: 'ok' },
      policy:       { verdict: 'flagged', reason: 'rm -rf detected' },
      tool_misuse:  { verdict: 'ok' },
    });
    const opts = { chatFn };

    const pipeline = new QualityClassifierPipeline({
      classifiers: [
        new OffTopicClassifier(resolver, opts),
        new CompletenessClassifier(resolver, opts),
        new CodeQualityClassifier(resolver, opts),
        new PolicyClassifier(resolver, opts),
        new ToolMisuseClassifier(resolver, opts),
      ],
      store: new QualityClassificationStore(handle.raw),
    });

    const result = await pipeline.classify({
      taskText: 'Refactor user.ts to remove the legacy login helper',
      outputText: 'Done. rm -rf /tmp/oldstuff',
    });

    expect(result.verdicts).toHaveLength(5);
    expect(result.worstVerdict).toBe('flagged');

    const rows = handle.raw
      .prepare('SELECT classifier_name, verdict FROM quality_classifications')
      .all() as Array<{ classifier_name: string; verdict: string }>;
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.classifier_name === 'policy')?.verdict).toBe('flagged');
  });

  it('emits a single aggregated telemetry event', async () => {
    seedProviderAndBindings(handle.raw);
    const providerStore = new ProviderStore(handle.raw);
    const bindings = new PipelineProviderBindingsStore(handle.raw);
    const resolver = new PipelineProviderResolver(bindings, providerStore);
    const sink = new InMemoryTelemetrySink();

    const pipeline = new QualityClassifierPipeline({
      classifiers: [new OffTopicClassifier(resolver, { chatFn: makeStubChat({}) })],
      telemetry: sink,
    });
    await pipeline.classify({ taskText: 't', outputText: 'o' });
    expect(sink.events.filter((e) => e.pipelineName === 'quality_classifiers')).toHaveLength(1);
  });

  it('returns verdict=error when no binding exists', async () => {
    // No bindings seeded.
    const providerStore = new ProviderStore(handle.raw);
    const bindings = new PipelineProviderBindingsStore(handle.raw);
    const resolver = new PipelineProviderResolver(bindings, providerStore);

    const store = new QualityClassificationStore(handle.raw);
    const pipeline = new QualityClassifierPipeline({
      classifiers: [new OffTopicClassifier(resolver)],
      store,
    });
    const result = await pipeline.classify({ taskText: 't', outputText: 'o', roundMessageId: 90 });
    expect(result.verdicts[0].verdict).toBe('error');
    expect(result.verdicts[0].reason).toMatch(/no provider binding/i);
    expect(store.overview()).toMatchObject({
      completedTasks: 1,
      assessments: 1,
      llmRequests: 0,
      infrastructureFailures: 1,
    });
  });

  it('one classifier failing does not stop others', async () => {
    seedProviderAndBindings(handle.raw);
    const providerStore = new ProviderStore(handle.raw);
    const bindings = new PipelineProviderBindingsStore(handle.raw);
    const resolver = new PipelineProviderResolver(bindings, providerStore);

    let calls = 0;
    const flakyChat = async () => {
      calls++;
      if (calls === 2) throw new Error('simulated chat failure');
      return { content: JSON.stringify({ verdict: 'ok' }), latencyMs: 1 };
    };

    const pipeline = new QualityClassifierPipeline({
      classifiers: [
        new OffTopicClassifier(resolver,   { chatFn: flakyChat as never }),
        new CompletenessClassifier(resolver,{ chatFn: flakyChat as never }),
        new CodeQualityClassifier(resolver, { chatFn: flakyChat as never }),
      ],
    });
    const result = await pipeline.classify({ taskText: 't', outputText: 'o' });
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.filter((v) => v.verdict === 'error').length).toBeGreaterThanOrEqual(1);
  });

  it('parses JSON wrapped in markdown code fences', async () => {
    seedProviderAndBindings(handle.raw);
    const providerStore = new ProviderStore(handle.raw);
    const bindings = new PipelineProviderBindingsStore(handle.raw);
    const resolver = new PipelineProviderResolver(bindings, providerStore);

    const wrappedChat = async () => ({
      content: '```json\n{"verdict": "warn", "reason": "wrapped"}\n```',
      latencyMs: 1,
    });
    const pipeline = new QualityClassifierPipeline({
      classifiers: [new OffTopicClassifier(resolver, { chatFn: wrappedChat as never })],
    });
    const result = await pipeline.classify({ taskText: 't', outputText: 'o' });
    expect(result.verdicts[0].verdict).toBe('warn');
    expect(result.verdicts[0].reason).toBe('wrapped');
  });
});
