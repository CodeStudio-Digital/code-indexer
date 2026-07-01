/**
 * Integration tests for POST /api/admin/pipeline-bindings/bulk/apply-profile —
 * the guided-setup ("Configuração assistida") fan-out.
 *
 * Uses FAKE stores (no SQLite) so the test runs under plain Node and asserts
 * the fan-out logic directly: each capability maps to its setup-eligible
 * catalog targets, each target keeps its OWN recommendedDefault.config, and
 * informational / cross-encoder entries are skipped.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountAdminPipelineBindingsRoutes } from '../pipeline-bindings.js';
import type { ServerDeps } from '../../../deps.js';
import type { PipelineProfileApplyRow } from '@mcp/store/pipeline-provider-bindings-store.js';

interface Captured { rows: PipelineProfileApplyRow[] | null }

function setup(opts: { knownProviders?: Set<string> } = {}) {
  const known = opts.knownProviders ?? new Set(['cf-1', 'openai-1', 'anthropic-1']);
  const captured: Captured = { rows: null };
  const pipelineBindingsStore = {
    bulkApplyProfile(rows: PipelineProfileApplyRow[]): number[] {
      captured.rows = rows;
      return rows.map((_, i) => i + 1);
    },
  };
  const providerStore = {
    getProvider(id: string) {
      return known.has(id) ? { id, name: id, kind: 'cloudflare', enabled: true } : null;
    },
  };
  const app = new Hono();
  mountAdminPipelineBindingsRoutes(app, { pipelineBindingsStore, providerStore } as unknown as ServerDeps);
  return { app, captured };
}

async function post(app: Hono, body: unknown) {
  return app.request('/api/admin/pipeline-bindings/bulk/apply-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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
    const classifier = rows.find((row) => row.pipeline_name === 'quality_off_topic' && row.binding_role === 'classifier');
    const reviewer = rows.find((row) => row.pipeline_name === 'snapshot_review' && row.binding_role === 'reviewer');
    expect((classifier!.config as { max_tokens: number }).max_tokens).toBe(256);
    expect((reviewer!.config as { max_tokens: number }).max_tokens).toBe(4000);
    expect((reviewer!.config as { json_mode: boolean }).json_mode).toBe(true);
  });

  it('skips informational + cross-encoder entries for embeddings/reranking', async () => {
    const { app, captured } = setup();
    await post(app, { assignments: [
      { capability_kind: 'embeddings', provider_id: 'cf-1', model_id: 'bge-m3' },
      { capability_kind: 'reranking',  provider_id: 'cf-1', model_id: 'llama-8b' },
    ] });
    const rows = captured.rows!;
    // doc_ingest embedder is informational → skipped.
    expect(rows.some((row) => row.pipeline_name === 'doc_ingest' && row.binding_role === 'embedder')).toBe(false);
    // indexer_search reranker is a cross-encoder → skipped.
    expect(rows.some((row) => row.pipeline_name === 'indexer_search' && row.binding_role === 'reranker')).toBe(false);
    // A real LLM reranker (doc_search) IS included.
    expect(rows.some((row) => row.pipeline_name === 'doc_search' && row.binding_role === 'reranker')).toBe(true);
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
