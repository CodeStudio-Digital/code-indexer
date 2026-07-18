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
  const dir = mkdtempSync(join(tmpdir(), 'mcp-max-output-tokens-test-'));
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
  try { h.db.close(); } catch { /* noop */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* noop */ }
}

describe('provider_models.default_max_tokens', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('round-trips an admin-set value and clear', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-5.1', name: 'GLM 5.1', default_max_tokens: 16_000 },
    ]);
    h.store.updateModel('zai', 'glm-5.1', '', { default_max_tokens: 24_000 });
    expect(h.store.listModels('zai')[0]?.default_max_tokens).toBe(24_000);

    h.store.updateModel('zai', 'glm-5.1', '', { default_max_tokens: null });
    expect(h.store.listModels('zai')[0]?.default_max_tokens).toBeNull();
  });

  it('preserves the persisted value across live refresh', () => {
    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-5.1', name: 'GLM 5.1', default_max_tokens: 16_000 },
    ]);
    h.store.updateModel('zai', 'glm-5.1', '', { default_max_tokens: 24_000 });

    h.store.replaceModelsFromSource('zai', 'live', [
      { model_id: 'glm-5.1', name: 'GLM 5.1 updated', default_max_tokens: 32_000 },
    ]);

    const row = h.store.listModels('zai')[0];
    expect(row?.name).toBe('GLM 5.1 updated');
    expect(row?.default_max_tokens).toBe(24_000);
  });
});
