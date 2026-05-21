/**
 * Focused tests for the tolerant JSON parser inside `llm-classifier.ts`.
 *
 * We exercise the parser through `OffTopicClassifier.classify()` with a stub
 * `chatFn` that returns the exact raw payload we want to test — the verdict
 * comes back through the same parseVerdict path as production.
 *
 * Each case here corresponds to a real failure mode we saw in
 * quality_classifications when the provider was GLM-5 / ZAI:
 *   - `<think>...</think>` reasoning leak
 *   - Markdown ```json``` fences
 *   - Preamble prose before the JSON
 *   - Trailing prose after the JSON
 *   - Trailing commas inside the JSON object
 *   - Combinations of the above
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PipelineProviderResolver } from '../../pipelines/index.js';
import { OffTopicClassifier } from '../classifiers.js';
import type { ChatMessage } from '../llm-chat.js';

interface DbHandle { db: CodeIndexDB; raw: ReturnType<CodeIndexDB['raw']>; dir: string; }

function setupDb(): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-parser-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, raw: db.raw(), dir };
}
function teardown(h: DbHandle) {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seed(raw: DbHandle['raw']): void {
  raw.prepare(
    `INSERT INTO provider_configs (id, name, kind, base_url, api_key, auth_mode, enabled, use_for_agent, use_for_coder, is_default)
     VALUES ('cf-1', 'CF', 'cloudflare', 'https://api.cloudflare.com/v1', 'k', 'api_key', 1, 1, 1, 1)`,
  ).run();
  new PipelineProviderBindingsStore(raw).upsert({
    pipeline_name: 'quality_off_topic',
    binding_role: 'classifier',
    provider_id: 'cf-1',
    model_id: '@cf/meta/llama-3.2-3b-instruct',
    scope_type: 'global',
    scope_id: null,
    config: { temperature: 0, max_tokens: 256 },
  });
}

function makeFixedChat(payload: string) {
  return async (
    _b: import('../../pipelines/index.js').ResolvedBinding,
    _m: ChatMessage[],
  ) => ({ content: payload, latencyMs: 1 });
}

function makeClassifier(handle: DbHandle, payload: string) {
  const providerStore = new ProviderStore(handle.raw);
  const bindings = new PipelineProviderBindingsStore(handle.raw);
  const resolver = new PipelineProviderResolver(bindings, providerStore);
  return new OffTopicClassifier(resolver, { chatFn: makeFixedChat(payload) });
}

describe('LLMClassifier tolerant JSON parser', () => {
  let handle: DbHandle;
  beforeEach(() => { handle = setupDb(); seed(handle.raw); });
  afterEach(() => teardown(handle));

  it('parses bare JSON', async () => {
    const c = makeClassifier(handle, '{"verdict":"ok","confidence":0.9,"reason":"clean"}');
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('clean');
  });

  it('strips <think>...</think> reasoning blocks (GLM-5 style)', async () => {
    const payload = '<think>\nLet me reason step by step...\nThis looks on-topic.\n</think>\n{"verdict":"ok"}';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
  });

  it('handles markdown ```json fences', async () => {
    const payload = '```json\n{"verdict":"warn","reason":"partial"}\n```';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('partial');
  });

  it('handles markdown fence without language tag', async () => {
    const payload = '```\n{"verdict":"flagged"}\n```';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('flagged');
  });

  it('extracts JSON from preamble prose', async () => {
    const payload = 'Sure, here is the verdict you requested: {"verdict":"ok","confidence":0.7}';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
    expect(r.confidence).toBeCloseTo(0.7);
  });

  it('extracts JSON despite trailing prose', async () => {
    const payload = '{"verdict":"warn","reason":"meh"} Hope this helps!';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('warn');
  });

  it('tolerates trailing commas in objects', async () => {
    // Strict JSON.parse rejects this; brace-extraction + comma-strip should rescue it.
    const payload = 'Here you go: {"verdict": "ok", "reason": "fine",}';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
  });

  it('handles combined cruft: think + fences + prose + trailing comma', async () => {
    const payload = [
      '<think>I should answer with JSON only.</think>',
      'Here is my reply:',
      '```json',
      '{"verdict": "flagged", "reason": "off-topic",}',
      '```',
      'Anything else?',
    ].join('\n');
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('flagged');
    expect(r.reason).toBe('off-topic');
  });

  it('respects braces inside string literals while extracting', async () => {
    // The `}` inside the string literal must NOT close the object early.
    const payload = '{"verdict":"ok","reason":"the user said \\"} is fine\\""}';
    const c = makeClassifier(handle, payload);
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
  });

  it('returns verdict=error on truly unparseable output', async () => {
    const c = makeClassifier(handle, 'Sorry, I cannot comply.');
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('error');
    expect(r.reason).toMatch(/unparseable/i);
  });

  it('returns verdict=error on invalid verdict field', async () => {
    const c = makeClassifier(handle, '{"verdict":"definitely_bad"}');
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('error');
    expect(r.reason).toMatch(/bad verdict/i);
  });

  it('clamps confidence to [0,1]', async () => {
    const c = makeClassifier(handle, '{"verdict":"ok","confidence":1.7}');
    const r = await c.classify({ taskText: 't', outputText: 'o' });
    expect(r.verdict).toBe('ok');
    expect(r.confidence).toBe(1);
  });
});
