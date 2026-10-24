/**
 * Tests for `seedFromEnvIfEmpty` — provider credentials are never sourced from
 * the environment. The provider configuration (admin UI / `provider_configs`
 * row) is the sole credential source; an env token like `ZAI_API_KEY` is inert.
 *
 *   - Built-in api-key shapes are seeded `enabled=0`, `api_key=null` even when a
 *     matching *_API_KEY env var is set.
 *   - A key a prior build copied from the env into the DB is un-baked (cleared +
 *     disabled + default dropped) on the next seed, so the change takes effect
 *     on an existing DB.
 *   - A user-configured key that does NOT match the env value is left untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { ProviderStore } from '../provider-store.js';
import { getDefinition, registerProvider, unregisterProvider } from '@mcp/services/providers/registry.js';

interface Handle {
  db: CodeIndexDB;
  store: ProviderStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-seed-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new ProviderStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('seedFromEnvIfEmpty — env tokens are inert', () => {
  let h: Handle;
  const orig = process.env.ZAI_API_KEY;
  beforeEach(() => {
    h = setup();
    process.env.ZAI_API_KEY = 'env-token-XYZ';
  });
  afterEach(() => {
    teardown(h);
    unregisterProvider('seed-test-plugin');
    if (orig !== undefined) process.env.ZAI_API_KEY = orig;
    else delete process.env.ZAI_API_KEY;
  });

  it('seeds the zai builtin disabled with no key even when ZAI_API_KEY is set', () => {
    h.store.seedFromEnvIfEmpty();
    const zai = h.store.getProvider('zai');
    expect(zai).not.toBeNull();
    expect(zai!.enabled).toBe(false);
    expect(zai!.api_key).toBeNull();
    expect(zai!.is_default).toBe(false);
  });

  it('un-bakes an existing row whose key equals the current env value', () => {
    // Simulate an older build that copied ZAI_API_KEY into the DB, enabled + default.
    h.store.upsertProvider({
      id: 'zai',
      name: 'Z.AI',
      kind: 'zai',
      api_key: 'env-token-XYZ',
      enabled: true,
      is_default: true,
    });

    h.store.seedFromEnvIfEmpty();

    const zai = h.store.getProvider('zai');
    expect(zai!.api_key).toBeNull();
    expect(zai!.enabled).toBe(false);
    expect(zai!.is_default).toBe(false);
  });

  it('leaves a user-configured key intact when it does not match the env value', () => {
    h.store.upsertProvider({
      id: 'zai',
      name: 'Z.AI',
      kind: 'zai',
      api_key: 'my-real-key',
      enabled: true,
      is_default: true,
    });

    h.store.seedFromEnvIfEmpty();

    const zai = h.store.getProvider('zai');
    expect(zai!.api_key).toBe('my-real-key');
    expect(zai!.enabled).toBe(true);
  });

  it('seeds newly registered plugin metadata without enabling its credentials', () => {
    const builtin = getDefinition('openai')!;
    registerProvider({
      ...builtin,
      kind: 'seed-test-plugin',
      displayName: 'Seed test plugin',
      defaultBaseURL: 'https://seed-test.invalid/v1',
      envVars: ['SEED_TEST_PLUGIN_API_KEY'],
    });

    h.store.seedFromEnvIfEmpty();

    expect(h.store.getProvider('seed-test-plugin')).toMatchObject({
      name: 'Seed test plugin',
      base_url: 'https://seed-test.invalid/v1',
      enabled: false,
      api_key: null,
    });
  });
});
