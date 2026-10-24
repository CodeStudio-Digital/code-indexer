import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import { listDefinitions } from '@mcp/services/providers/registry.js';
import { miscTools } from '../misc.js';
import type { ToolContext } from '../../context.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture(count = 0) {
  const root = mkdtempSync(join(tmpdir(), 'model-catalog-')), db = new CodeIndexDB(join(root, 'db.sqlite'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = new ProviderStore(db.raw());
  if (count) {
    store.upsertProvider({ id: 'profile-provider', name: 'Profile', kind: 'openai', enabled: true, api_key: 'never-expose-this' });
    store.replaceModelsFromSource('profile-provider', 'manual', Array.from({ length: count }, (_, i) => ({
      model_id: `model-${String(i).padStart(4, '0')}`, name: `Model ${String(i).padStart(4, '0')}`, enabled: true,
    })));
  }
  const modelDiscovery = new ModelDiscovery(db), ctx = { modelDiscovery } as ToolContext;
  return { db, store, modelDiscovery, ctx };
}
const tool = miscTools.find(t => t.name === 'list_models')!;
const text = (r: Awaited<ReturnType<typeof tool.handler>>) => typeof r === 'string' ? r : r.text;

it('pages the active profile in SQL with recovery, without loading credentials or a second profile', async () => {
  const { db, ctx, store } = fixture(553);
  store.upsertProvider({ id: 'disabled', name: 'Disabled', kind: 'openai', enabled: false });
  store.replaceModelsFromSource('disabled', 'manual', [{ model_id: 'secret-disabled', name: 'Disabled' }]);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const prepare = vi.spyOn(db.raw(), 'prepare');
  const first = await tool.handler({ provider: 'openai', limit: 500 }, ctx);
  expect(first).toMatchObject({ sourceTruncations: [{ inputSize: 553, outputSize: 500, recoverable: true }] });
  expect(text(first)).toContain('"next_offset":500'); expect(text(first)).not.toContain('model-0500');
  const last = text(await tool.handler({ provider: 'profile-provider', offset: 500, limit: 500 }, ctx));
  expect(last).toContain('model-0552'); expect(last).not.toContain('model-0499'); expect(last).not.toContain('secret-disabled');
  expect(last).not.toContain('never-expose-this'); expect(fetch).not.toHaveBeenCalled();
  expect(prepare.mock.calls.some(([sql]) => /SELECT \*|api_key/.test(sql))).toBe(false);
});

it('keeps default discovery offline even when a provider environment key is present', async () => {
  const { db, modelDiscovery } = fixture(); vi.stubEnv('OPENAI_API_KEY', 'test-only');
  const fetch = vi.fn(), write = vi.spyOn(db, 'setCachedModels'); vi.stubGlobal('fetch', fetch);
  expect((await modelDiscovery.discoverModels('openai')).length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it('limits concurrent live reads to four and preserves provider order without tool cache writes', async () => {
  const { db, modelDiscovery } = fixture();
  const selected = listDefinitions().filter(d => ['openai', 'anthropic', 'openrouter', 'deepseek', 'zai', 'kimi-code', 'gemini'].includes(d.kind));
  selected.forEach(d => { if (d.envVars[0]) vi.stubEnv(d.envVars[0], 'test-only'); });
  let active = 0, maximum = 0; const waiting: Array<() => void> = [];
  vi.stubGlobal('fetch', vi.fn(async () => {
    active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => waiting.push(resolve)); active--;
    return Response.json({ data: [{ id: 'live-model' }], models: [{ name: 'models/live-model', supportedGenerationMethods: ['generateContent'] }] });
  }));
  const write = vi.spyOn(db, 'setCachedModels');
  let done = false;
  const result = modelDiscovery.discoverModels(undefined, true, { persistCache: false }).finally(() => { done = true; });
  while (!done) { await setImmediate(); waiting.splice(0).forEach(resolve => resolve()); }
  const models = await result;
  expect(maximum).toBe(4); expect(write).not.toHaveBeenCalled();
  expect(models.filter(m => m.id === 'live-model').map(m => m.provider)).toEqual(selected.map(d => d.kind));
});

it('awaits body cancellation and never falls back or writes after the caller aborts', async () => {
  const { db, modelDiscovery } = fixture(); vi.stubEnv('OPENAI_API_KEY', 'test-only');
  let started!: () => void, released!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const receipt = new Promise<void>(resolve => { released = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { return receipt; } }))));
  const ctrl = new AbortController(), fallback = vi.fn(), write = vi.spyOn(db, 'setCachedModels');
  const pending = modelDiscovery.discoverModels('openai', true, { signal: ctrl.signal, onFallback: fallback });
  const rejected = expect(pending).rejects.toThrow('attempt stopped');
  await reading; ctrl.abort(new Error('attempt stopped')); await setImmediate();
  expect(fallback).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); released(); await rejected;
});

it('enforces the overall deadline through a stalled response body', async () => {
  const { modelDiscovery } = fixture(); vi.stubEnv('OPENAI_API_KEY', 'test-only'); vi.useFakeTimers();
  const cancel = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }))));
  const pending = modelDiscovery.discoverModels('openai', true);
  const rejected = expect(pending).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(cancel).toHaveBeenCalledOnce();
});

it('reports failed or oversized live catalogs as local fallbacks and discards invalid cache rows', async () => {
  const { db, modelDiscovery } = fixture(); vi.stubEnv('OPENAI_API_KEY', 'test-only');
  const fallback = vi.fn(), cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '5000000' } })));
  expect((await modelDiscovery.discoverModels('openai', true, { onFallback: fallback })).length).toBeGreaterThan(0);
  expect(fallback).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  db.raw().prepare("INSERT INTO models_cache(provider, models, fetched_at) VALUES ('openai', ?, datetime('now'))").run('{invalid');
  expect(db.getCachedModels('openai')).toBeNull();
  db.raw().prepare("UPDATE models_cache SET models=? WHERE provider='openai'").run('x'.repeat(4194305));
  expect(db.getCachedModels('openai')).toBeNull();
});

it('rejects invalid page arguments and cancellation before reading any models', async () => {
  const { ctx, modelDiscovery } = fixture(); const page = vi.spyOn(modelDiscovery, 'discoverPage');
  for (const args of [{ provider: 1 }, { live: 'true' }, { offset: -1 }, { limit: 501 }, { limit: 0 }]) {
    await expect(tool.handler(args, ctx)).rejects.toThrow();
  }
  page.mockClear();
  await expect(tool.handler({}, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
  expect(page).not.toHaveBeenCalled();
});
