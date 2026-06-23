/**
 * Verifies `replaceModelsFromSource` preserves the admin's
 * `default_reasoning_level` choice across refreshes — same policy as `enabled`.
 *
 * Reproduces the scenario the user hit: pick `medium` in admin → click
 * "refresh" → the seed default ("xhigh"/"high") would otherwise overwrite
 * the choice. Now: existing rows keep whatever the admin set, including
 * `null` (= explicit "auto").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';

const PROVIDER_ID = 'claude-code';

function makeSeedModels() {
  return [
    {
      model_id: 'opus',
      mode: '',
      name: 'Opus',
      can_reason: true,
      supports_attachments: true,
      default_reasoning_level: 'xhigh',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
      source: 'live',
    },
    {
      model_id: 'sonnet',
      mode: '',
      name: 'Sonnet',
      can_reason: true,
      supports_attachments: true,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'medium', 'high'],
      source: 'live',
    },
  ];
}

describe('provider_models default_reasoning_level survival', () => {
  let dbDir: string;
  let store: ProviderStore;
  let indexDb: CodeIndexDB;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'mcp-pm-reasoning-'));
    indexDb = new CodeIndexDB(join(dbDir, 'test.db'));
    store = new ProviderStore(indexDb.raw());
    store.upsertProvider({
      id: PROVIDER_ID,
      name: 'Claude Code',
      kind: 'claude-code',
      base_url: 'https://api.anthropic.com',
      api_key: null,
      auth_mode: 'oauth',
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
      // Windows occasionally holds the WAL/SHM file briefly after close;
      // tmp dir cleanup is best-effort.
    }
  });

  it('first seed → uses seed default_reasoning_level for new rows', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    const opus = store.listModels(PROVIDER_ID).find((m) => m.model_id === 'opus')!;
    expect(opus.default_reasoning_level).toBe('xhigh');
  });

  it('admin picks "medium" → refresh keeps "medium" (does NOT revert to seed)', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    store.updateModel(PROVIDER_ID, 'opus', '', { default_reasoning_level: 'medium' });
    expect(store.listModels(PROVIDER_ID).find((m) => m.model_id === 'opus')!.default_reasoning_level).toBe('medium');

    // Simulate "refresh models" — same seed payload re-applied.
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    expect(store.listModels(PROVIDER_ID).find((m) => m.model_id === 'opus')!.default_reasoning_level).toBe('medium');
  });

  it('admin picks "auto" (null) → refresh keeps null (NOT seed default)', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    store.updateModel(PROVIDER_ID, 'sonnet', '', { default_reasoning_level: null });
    expect(store.listModels(PROVIDER_ID).find((m) => m.model_id === 'sonnet')!.default_reasoning_level).toBeNull();

    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    expect(store.listModels(PROVIDER_ID).find((m) => m.model_id === 'sonnet')!.default_reasoning_level).toBeNull();
  });

  it('supported_reasoning_levels keeps tracking the seed (capability, not preference)', () => {
    store.replaceModelsFromSource(PROVIDER_ID, 'live', makeSeedModels());
    // Seed evolves: opus gains a hypothetical extra level.
    const evolved = makeSeedModels().map((m) =>
      m.model_id === 'opus'
        ? { ...m, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'extra'] }
        : m,
    );
    store.replaceModelsFromSource(PROVIDER_ID, 'live', evolved);
    expect(
      store.listModels(PROVIDER_ID).find((m) => m.model_id === 'opus')!
        .supported_reasoning_levels,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'extra']);
  });
});
