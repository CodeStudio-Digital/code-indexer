/**
 * Verifies `replaceModelsFromSource` preserves the admin's manual
 * `context_window` override across live-discovery refreshes (migration 175).
 *
 * Reproduces the user-reported bug: a Z.AI model whose real window is 1M
 * (`glm-5.2`) defaults to the registry's 200K. The admin bumps it to 1M in
 * the admin UI; the next app restart fires the background refresh, which
 * re-derives 200K from discovery and silently reverts the admin's value.
 *
 * Policy: only an ADMIN-set window is frozen (`context_window_overridden`).
 * A window that merely came from discovery keeps refreshing — otherwise
 * providers with real upstream windows (OpenRouter) would freeze too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';

const PROVIDER_ID = 'zai';

/** What live discovery supplies for Z.AI — the registry value, not the real 1M. */
function makeDiscoveredModels() {
  return [
    { model_id: 'glm-5.2', mode: '', name: 'glm-5.2', context_window: 200_000, source: 'live' as const },
    { model_id: 'glm-4.6', mode: '', name: 'glm-4.6', context_window: 200_000, source: 'live' as const },
  ];
}

describe('provider_models context_window override survival', () => {
  let dbDir: string;
  let store: ProviderStore;
  let indexDb: CodeIndexDB;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'mcp-pm-ctxwin-'));
    indexDb = new CodeIndexDB(join(dbDir, 'test.db'));
    store = new ProviderStore(indexDb.raw());
    store.upsertProvider({
      id: PROVIDER_ID,
      name: 'zai',
      kind: 'zai',
      base_url: 'https://api.z.ai/api/paas/v4',
      api_key: 'k',
      auth_mode: 'api_key',
      enabled: true,
      use_for_agent: true,
      use_for_coder: true,
      use_for_general: false,
      is_default: false,
      extra: {},
    });
  });

  afterEach(() => {
    store.close();
    indexDb.close();
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // Windows occasionally holds the WAL/SHM file briefly after close.
    }
  });

  it('first discovery → uses the discovered window; not flagged as overridden', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());
    const m = store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-5.2')!;
    expect(m.context_window).toBe(200_000);
    expect(m.context_window_overridden).toBe(false);
  });

  it('admin sets 1M → refresh keeps 1M (does NOT revert to discovery 200K)', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());
    store.updateModel(PROVIDER_ID, 'glm-5.2', '', { context_window: 1_000_000 });

    const afterSet = store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-5.2')!;
    expect(afterSet.context_window).toBe(1_000_000);
    expect(afterSet.context_window_overridden).toBe(true);

    // Simulate the background refresh on restart — discovery re-supplies 200K.
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());

    const afterRefresh = store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-5.2')!;
    expect(afterRefresh.context_window).toBe(1_000_000);
    expect(afterRefresh.context_window_overridden).toBe(true);
  });

  it('non-overridden models keep tracking discovery across refreshes', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());
    // Upstream bumps glm-4.6 to 256K — a non-overridden row must pick it up.
    const evolved = makeDiscoveredModels().map((m) =>
      m.model_id === 'glm-4.6' ? { ...m, context_window: 256_000 } : m,
    );
    store.replaceModelsFromSource(PROVIDER_ID, 'live', evolved);
    expect(store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-4.6')!.context_window).toBe(256_000);
  });

  it('clearing the override (null) reverts to discovery on the next refresh', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());
    store.updateModel(PROVIDER_ID, 'glm-5.2', '', { context_window: 1_000_000 });
    // Admin clears the override (empty input → null).
    store.updateModel(PROVIDER_ID, 'glm-5.2', '', { context_window: null });

    const cleared = store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-5.2')!;
    expect(cleared.context_window_overridden).toBe(false);

    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeDiscoveredModels());
    expect(store.listModels(PROVIDER_ID).find((x) => x.model_id === 'glm-5.2')!.context_window).toBe(200_000);
  });
});
