/**
 * Tests for the ChatGPT/Codex live model discovery (P0+P1).
 *
 * Covers:
 *   1. 200 OK → models persisted with rich metadata; ETag stored.
 *   2. 200 OK with `visibility='hidden'` → row stored with enabled=0.
 *   3. 200 OK with `supported_in_api=false` → row stored with enabled=0.
 *   4. 304 Not Modified → store untouched, ETag preserved.
 *   5. Network failure / 5xx → fallback to CHATGPT_SEED_MODELS.
 *   6. Admin toggle of `enabled` survives a subsequent refresh.
 *
 * Strategy: stub `fetch` and `resolveChatGPTCreds`. Use a real SQLite DB
 * in tmpdir so migrations and the new columns are exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../core/providers/shared/oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../core/providers/shared/oauth.js')>(
    '../core/providers/shared/oauth.js',
  );
  return {
    ...actual,
    resolveChatGPTCreds: vi.fn().mockResolvedValue({
      apiKey: 'access-token-123',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      extra: { accountId: 'acct-abc' },
    }),
  };
});

import { CodeIndexDB } from '../store/db.js';
import { ProviderStore } from '../store/provider-store.js';
import { discoverChatgpt } from '../apps/http-api/admin/model-discovery/chatgpt.js';
import { CHATGPT_SEED_MODELS } from '../core/services/oauth/openai.js';

const PROVIDER_ID = 'chatgpt';

function makeProviderConfig() {
  return {
    id: PROVIDER_ID,
    name: 'ChatGPT',
    kind: 'chatgpt',
    base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: 'access-token-123',
    auth_mode: 'oauth' as const,
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: false,
    is_default: false,
    extra: {},
    fallback_provider_id: null,
    created_at: '',
    updated_at: '',
  };
}

function mockResponse(opts: {
  status: number;
  body?: unknown;
  etag?: string;
}): Response {
  const headers = new Headers();
  if (opts.etag) headers.set('etag', opts.etag);
  return new Response(opts.body !== undefined ? JSON.stringify(opts.body) : null, {
    status: opts.status,
    headers,
  });
}

const sampleModel = {
  slug: 'gpt-5.5',
  display_name: 'GPT-5.5',
  description: 'frontier',
  context_window: 272000,
  max_context_window: 272000,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
  apply_patch_tool_type: 'freeform',
  available_in_plans: ['plus', 'pro', 'team'],
  minimal_client_version: '0.124.0',
  visibility: 'list' as const,
  supported_in_api: true,
  input_modalities: ['text', 'image'],
};

describe('ChatGPT model discovery', () => {
  let dir: string;
  let db: CodeIndexDB;
  let store: ProviderStore;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chatgpt-discovery-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    store = new ProviderStore(db.raw());
    store.upsertProvider({
      id: PROVIDER_ID,
      name: 'ChatGPT',
      kind: 'chatgpt',
      auth_mode: 'oauth',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('200 → persists models with rich metadata and stores ETag', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ status: 200, body: { models: [sampleModel] }, etag: 'W/"abc"' }),
    );

    const cfg = store.getProvider(PROVIDER_ID)!;
    const result = await discoverChatgpt(cfg, null);

    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('W/"abc"');
    expect(result.models).toHaveLength(1);

    store.replaceModelsFromSource(PROVIDER_ID, 'live', result.models);
    store.setProviderCatalogEtag(PROVIDER_ID, result.etag);

    const persisted = store.listModels(PROVIDER_ID)[0];
    expect(persisted.model_id).toBe('gpt-5.5');
    expect(persisted.display_name).toBe('GPT-5.5');
    expect(persisted.context_window).toBe(272000);
    expect(persisted.default_reasoning_level).toBe('medium');
    expect(persisted.supported_reasoning_levels).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(persisted.apply_patch_tool_type).toBe('freeform');
    expect(persisted.available_in_plans).toEqual(['plus', 'pro', 'team']);
    expect(persisted.minimal_client_version).toBe('0.124.0');
    expect(persisted.visibility).toBe('list');
    expect(persisted.supported_in_api).toBe(true);
    expect(persisted.input_modalities).toEqual(['text', 'image']);
    expect(persisted.enabled).toBe(true);

    expect(store.getProviderCatalogEtag(PROVIDER_ID)).toBe('W/"abc"');
  });

  it('hidden visibility → enabled=0 by default', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: { models: [{ ...sampleModel, slug: 'internal-x', visibility: 'hidden' }] },
      }),
    );
    const result = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    store.replaceModelsFromSource(PROVIDER_ID, 'live', result.models);
    const row = store.listModels(PROVIDER_ID)[0];
    expect(row.enabled).toBe(false);
    expect(row.visibility).toBe('hidden');
  });

  it('supported_in_api=false → enabled=0 by default', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: { models: [{ ...sampleModel, slug: 'cli-only', supported_in_api: false }] },
      }),
    );
    const result = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    store.replaceModelsFromSource(PROVIDER_ID, 'live', result.models);
    const row = store.listModels(PROVIDER_ID)[0];
    expect(row.enabled).toBe(false);
    expect(row.supported_in_api).toBe(false);
  });

  it('304 Not Modified → result.notModified, no rewrite', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 304 }));
    const result = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, 'W/"abc"');
    expect(result.notModified).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.etag).toBe('W/"abc"');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/models?client_version='),
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-None-Match': 'W/"abc"' }) as unknown,
      }),
    );
  });

  it('network failure → falls back to seed list', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    expect(result.notModified).toBe(false);
    expect(result.etag).toBeNull();
    expect(result.models).toHaveLength(CHATGPT_SEED_MODELS.length);
    expect(result.models[0].source).toBe('live');
  });

  it('500 from upstream → falls back to seed list', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 502, body: 'bad gateway' }));
    const result = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    expect(result.models).toHaveLength(CHATGPT_SEED_MODELS.length);
  });

  it('admin toggle of enabled survives a refresh', async () => {
    // First refresh: model is persisted enabled=true (default).
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ status: 200, body: { models: [sampleModel] }, etag: 'v1' }),
    );
    const r1 = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    store.replaceModelsFromSource(PROVIDER_ID, 'live', r1.models);
    expect(store.listModels(PROVIDER_ID)[0].enabled).toBe(true);

    // Admin disables it via PATCH semantics.
    store.updateModel(PROVIDER_ID, 'gpt-5.5', '', { enabled: false });
    expect(store.listModels(PROVIDER_ID)[0].enabled).toBe(false);

    // Second refresh: same payload → toggle must be preserved.
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ status: 200, body: { models: [sampleModel] }, etag: 'v2' }),
    );
    const r2 = await discoverChatgpt(store.getProvider(PROVIDER_ID)!, 'v1');
    store.replaceModelsFromSource(PROVIDER_ID, 'live', r2.models);
    expect(store.listModels(PROVIDER_ID)[0].enabled).toBe(false);
  });

  it('sends Codex-style headers and client_version query param', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ status: 200, body: { models: [] } }),
    );
    await discoverChatgpt(store.getProvider(PROVIDER_ID)!, null);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/models\?client_version=/);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-token-123');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-abc');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['User-Agent']).toMatch(/^codex_cli_rs\//);
    expect(headers.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
