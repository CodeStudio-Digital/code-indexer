/**
 * Integration tests for POST /api/admin/pipeline-bindings/bulk/apply-profile —
 * the guided-setup ("Configuração assistida") fan-out.
 *
 * Uses FAKE stores (no SQLite) so the test runs under plain Node and asserts
 * the fan-out logic directly: each capability maps to its setup-eligible
 * catalog targets, each target keeps its OWN recommendedDefault.config, and
 * semantic-profile / cross-encoder roles are absent.
 */
import { describe, expect, it } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { mountAdminPipelineBindingsRoutes } from '../pipeline-bindings.js';
import type { ServerDeps } from '../../../deps.js';
import type { PipelineProfileApplyRow } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PIPELINE_CATALOG } from '@mcp/services/pipelines/index.js';

interface Captured {
  rows: PipelineProfileApplyRow[] | null;
  activated: Record<string, unknown> | null;
  bulkTargets: Array<{ pipeline_name: string; binding_role: string }> | null;
  updated: Record<string, unknown> | null;
  upserted: Record<string, unknown> | null;
}

function setup(opts: { knownProviders?: Set<string> } = {}) {
  const known = opts.knownProviders ?? new Set(['cf-1', 'openai-1', 'anthropic-1']);
  const captured: Captured = {
    rows: null,
    activated: null,
    bulkTargets: null,
    updated: null,
    upserted: null,
  };
  const pipelineBindingsStore = {
    list() {
      return [];
    },
    upsert(input: Record<string, unknown>) {
      captured.upserted = input;
      return 51;
    },
    bulkApply(input: { targets: Array<{ pipeline_name: string; binding_role: string }> }): number[] {
      captured.bulkTargets = input.targets;
      return input.targets.map((_, i) => i + 1);
    },
    bulkApplyProfile(rows: PipelineProfileApplyRow[]): number[] {
      captured.rows = rows;
      return rows.map((_, i) => i + 1);
    },
    activateGlobal(input: Record<string, unknown>) {
      captured.activated = input;
      return { id: 41, disabledIds: [7, 8] };
    },
    update(_id: number, input: Record<string, unknown>) {
      captured.updated = input;
    },
    get(id: number) {
      return id === 41 ? {
        id,
        pipeline_name: 'editor',
        binding_role: 'autocomplete',
        provider_id: 'cf-1',
        model_id: 'codestral',
        model_mode: '',
        config: {},
        scope_type: 'global',
        scope_id: null,
        enabled: true,
        priority: 0,
      } : null;
    },
  };
  const providerStore = {
    getProvider(id: string) {
      return known.has(id) ? { id, name: id, kind: 'cloudflare', enabled: true } : null;
    },
  };
  const app = new HttpRouter();
  mountAdminPipelineBindingsRoutes(app, { pipelineBindingsStore, providerStore } as unknown as ServerDeps);
  return { app, captured };
}

async function post(app: HttpRouter, body: unknown) {
  return app.request('/api/admin/pipeline-bindings/bulk/apply-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postBulk(app: HttpRouter, body: unknown) {
  return app.request('/api/admin/pipeline-bindings/bulk/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bulk/apply', () => {
  it('rejects the removed session scope before touching the store', async () => {
    const { app, captured } = setup();
    const response = await postBulk(app, {
      provider_id: 'cf-1',
      model_id: 'llama-8b',
      scope_type: 'session',
      scope_id: 42,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'validation_failed',
      details: ['scope_type must be global|template'],
    });
    expect(captured.bulkTargets).toBeNull();
  });

  it('defaults to setup-eligible roles only', async () => {
    const { app, captured } = setup();
    const response = await postBulk(app, { provider_id: 'cf-1', model_id: 'llama-8b' });

    expect(response.status).toBe(200);
    const targets = captured.bulkTargets!;
    expect(targets.length).toBeGreaterThan(0);
    const appliedPairs = new Set(targets.map((target) => `${target.pipeline_name}::${target.binding_role}`));
    for (const entry of PIPELINE_CATALOG.filter((candidate) => candidate.setupEligible === false)) {
      expect(appliedPairs.has(`${entry.pipelineName}::${entry.bindingRole}`)).toBe(false);
    }
    for (const entry of PIPELINE_CATALOG.filter((candidate) => candidate.comingSoon)) {
      expect(appliedPairs.has(`${entry.pipelineName}::${entry.bindingRole}`)).toBe(false);
    }
  });

  it('rejects a retired no-effect target atomically', async () => {
    const { app, captured } = setup();
    const response = await postBulk(app, {
      provider_id: 'cf-1',
      model_id: 'llama-8b',
      targets: [
        { pipeline_name: 'quality_off_topic', binding_role: 'classifier' },
        { pipeline_name: 'doc_search', binding_role: 'reranker' },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'unknown_targets',
    });
    expect(captured.bulkTargets).toBeNull();
  });
});

describe('POST /bulk/apply-profile', () => {
  it('fans a text_llm assignment out to every text_llm role with its OWN config', async () => {
    const { app, captured } = setup();
    const r = await post(app, { assignments: [{ capability_kind: 'text_llm', provider_id: 'cf-1', model_id: 'llama-8b' }] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; applied: number; byCapability: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.applied).toBeGreaterThan(0);
    expect(body.byCapability.text_llm).toBe(body.applied);

    const rows = captured.rows!;
    expect(rows.every((row) => row.provider_id === 'cf-1' && row.model_id === 'llama-8b')).toBe(true);
    // Per-role config preserved: classifier (max_tokens:256) AND reviewer
    // (max_tokens:4000+json_mode) both present, each with its own config.
    const classifier = rows.find((row) => row.pipeline_name === 'doc_ingest' && row.binding_role === 'classifier');
    const reviewer = rows.find((row) => row.pipeline_name === 'snapshot_review' && row.binding_role === 'reviewer');
    expect((classifier!.config as { max_tokens: number }).max_tokens).toBe(256);
    expect((reviewer!.config as { max_tokens: number }).max_tokens).toBe(4000);
    expect((reviewer!.config as { json_mode: boolean }).json_mode).toBe(true);
  });

  it('keeps semantic-profile embeddings/rerankers out of pipeline setup', async () => {
    const { app, captured } = setup();
    await post(app, { assignments: [
      { capability_kind: 'embeddings', provider_id: 'cf-1', model_id: 'bge-m3' },
      { capability_kind: 'reranking',  provider_id: 'cf-1', model_id: 'llama-8b' },
    ] });
    const rows = captured.rows ?? [];
    // Embeddings and all cross-encoders are owned by semantic profiles.
    expect(rows.some((row) => row.binding_role === 'embedder')).toBe(false);
    // Both semantic cross-encoders are profile-owned.
    expect(rows.some((row) => row.pipeline_name === 'indexer_search' && row.binding_role === 'reranker')).toBe(false);
    expect(rows.some((row) => row.pipeline_name === 'doc_search' && row.binding_role === 'reranker')).toBe(false);
    expect(rows.some((row) => row.pipeline_name === 'memory_recall')).toBe(false);
    expect(rows.some((row) => row.pipeline_name === 'memory_query')).toBe(false);
  });

  it('400 on unknown capability', async () => {
    const { app } = setup();
    const r = await post(app, { assignments: [{ capability_kind: 'bogus', provider_id: 'cf-1', model_id: 'm' }] });
    expect(r.status).toBe(400);
  });

  it('400 on missing model_id', async () => {
    const { app } = setup();
    const r = await post(app, { assignments: [{ capability_kind: 'text_llm', provider_id: 'cf-1' }] });
    expect(r.status).toBe(400);
  });

  it('404 when a provider does not exist', async () => {
    const { app } = setup();
    const r = await post(app, { assignments: [{ capability_kind: 'text_llm', provider_id: 'ghost', model_id: 'm' }] });
    expect(r.status).toBe(404);
  });

  it('400 on empty assignments', async () => {
    const { app } = setup();
    const r = await post(app, { assignments: [] });
    expect(r.status).toBe(400);
  });

  it('400 on non-global scope_type', async () => {
    const { app } = setup();
    const r = await post(app, { scope_type: 'session', assignments: [{ capability_kind: 'text_llm', provider_id: 'cf-1', model_id: 'm' }] });
    expect(r.status).toBe(400);
  });
});

describe('POST /activate', () => {
  it('activates one global route and reports preserved bindings disabled', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name: 'editor', binding_role: 'autocomplete',
        provider_id: 'cf-1', model_id: 'codestral', config: { context_engine: 'v3' },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 41, disabledIds: [7, 8], binding: { enabled: true } });
    expect(captured.activated).toMatchObject({
      pipeline_name: 'editor', binding_role: 'autocomplete', provider_id: 'cf-1', model_id: 'codestral',
    });
  });

  it('rejects non-global activation without touching the store', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name: 'editor', binding_role: 'autocomplete', provider_id: 'cf-1', model_id: 'codestral',
        scope_type: 'session', scope_id: 3,
      }),
    });
    expect(response.status).toBe(400);
    expect(captured.activated).toBeNull();
  });

  it('rejects a dead semantic-profile binding', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name: 'indexer_search', binding_role: 'embedder',
        provider_id: 'cf-1', model_id: 'bge-m3',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'unknown_target',
    });
    expect(captured.activated).toBeNull();
  });
});

describe('POST /pipeline-bindings', () => {
  it('rejects session scope without writing a SQLite binding', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name: 'quality_policy',
        binding_role: 'classifier',
        provider_id: 'cf-1',
        model_id: 'm',
        scope_type: 'session',
        scope_id: 42,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'validation_failed',
      details: ['scope_type must be global|template'],
    });
    expect(captured.upserted).toBeNull();
  });

  it('does not recreate retired no-effect bindings', async () => {
    const { app } = setup();
    const response = await app.request('/api/admin/pipeline-bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name: 'doc_search', binding_role: 'reranker',
        provider_id: 'cf-1', model_id: 'old-reranker', scope_type: 'global',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'unknown_target',
    });
  });
});

describe('PATCH /pipeline-bindings/:id', () => {
  it('cannot move a reusable binding into session scope', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings/41', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope_type: 'session', scope_id: 42 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'scope_type must be global|template' });
    expect(captured.updated).toBeNull();
  });

  it('cannot rename a configurable binding into a retired target', async () => {
    const { app, captured } = setup();
    const response = await app.request('/api/admin/pipeline-bindings/41', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_name: 'indexer_search', binding_role: 'embedder' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown_target' });
    expect(captured.updated).toBeNull();
  });
});

describe('GET /pipeline-bindings', () => {
  it('rejects the removed session scope instead of silently listing reusable rows', async () => {
    const { app } = setup();
    const response = await app.request('/api/admin/pipeline-bindings?scope_type=session');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'scope_type must be global|template' });
  });
});
