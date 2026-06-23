/**
 * Tests for `provider_models.max_tools` (migration 135) — the admin-set
 * per-model tool-catalog cap.
 *
 * The invariant that matters most: `replaceFromSource` DELETE+INSERTs rows
 * on every live refresh and discovery never supplies `max_tools`, so the
 * admin's value must be preserved across refreshes (same policy as
 * `default_reasoning_level`). Without that, the nightly refresh silently
 * wipes the cap and weak models drown in tools again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { ProviderStore } from '../provider-store.js';

interface Handle {
  db: CodeIndexDB;
  store: ProviderStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-max-tools-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const raw = db.raw();
  raw
    .prepare(
      `INSERT OR IGNORE INTO provider_configs
         (id, name, kind, base_url, api_key, auth_mode, enabled, use_for_agent, use_for_coder, is_default)
       VALUES ('zai', 'ZAI', 'zai', '', '', 'api_key', 1, 1, 1, 0)`,
    )
    .run();
  return { db, store: new ProviderStore(raw), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('provider_models.max_tools', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('updateModel round-trips max_tools (set and clear)', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-4.5-flash', name: 'GLM 4.5 Flash' },
    ]);
    h.store.updateModel('zai', 'glm-4.5-flash', '', { max_tools: 24 });
    expect(h.store.listModels('zai')[0]?.max_tools).toBe(24);

    h.store.updateModel('zai', 'glm-4.5-flash', '', { max_tools: null });
    expect(h.store.listModels('zai')[0]?.max_tools).toBeNull();
  });

  it('replaceFromSource preserves the admin cap across a refresh that omits it', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-4.5-flash', name: 'GLM 4.5 Flash' },
    ]);
    h.store.updateModel('zai', 'glm-4.5-flash', '', { max_tools: 24 });

    // Live refresh — discovery never sends max_tools.
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-4.5-flash', name: 'GLM 4.5 Flash (renamed)' },
    ]);

    const row = h.store.listModels('zai').find((m) => m.model_id === 'glm-4.5-flash');
    expect(row?.name).toBe('GLM 4.5 Flash (renamed)');
    expect(row?.max_tools).toBe(24);
  });

  it('replaceFromSource seeds max_tools for newly seen rows when supplied', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-new', name: 'GLM New', max_tools: 16 },
    ]);
    expect(h.store.listModels('zai')[0]?.max_tools).toBe(16);
  });

  it('listAllModels hydrates max_tools (capability-cache feed)', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-4.5-flash', name: 'GLM 4.5 Flash' },
    ]);
    h.store.updateModel('zai', 'glm-4.5-flash', '', { max_tools: 20 });
    const all = h.store.listAllModels();
    expect(all.find((m) => m.model_id === 'glm-4.5-flash')?.max_tools).toBe(20);
  });
});
