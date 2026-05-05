import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';
import { ProviderStore, type ProviderKind } from '../store/provider-store.js';

function providerInput(id: string, kind: ProviderKind = 'openai') {
  return {
    id,
    name: id,
    kind,
    base_url: 'https://example.test/v1',
    api_key: 'sk-test',
    auth_mode: 'api_key' as const,
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: false,
    is_default: false,
    extra: {},
  };
}

describe('ProviderStore subagent target', () => {
  let dbDir: string;
  let indexDb: CodeIndexDB;
  let store: ProviderStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'mcp-subagent-target-'));
    indexDb = new CodeIndexDB(join(dbDir, 'test.db'));
    store = new ProviderStore(indexDb.raw());
    store.upsertProvider(providerInput('openai', 'openai'));
    store.upsertProvider(providerInput('kimi-code', 'kimi-code'));
  });

  afterEach(() => {
    store.close();
    indexDb.close();
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // Windows can hold SQLite sidecar files briefly after close.
    }
  });

  it('keeps the legacy same-provider subagent model behavior', () => {
    store.setSubagentModel('openai', 'gpt-4.1');

    expect(store.getSubagentModel('openai')).toBe('gpt-4.1');
    expect(store.getSubagentTarget('openai')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1',
    });
    expect(store.getProvider('openai')!.extra.subagent_provider_id).toBeUndefined();
  });

  it('stores a different provider and model for subagents', () => {
    store.setSubagentTarget('openai', 'kimi-code', 'kimi-k2.6');

    expect(store.getSubagentTarget('openai')).toEqual({
      providerId: 'kimi-code',
      modelId: 'kimi-k2.6',
    });
    expect(store.getProvider('openai')!.extra).toMatchObject({
      subagent_provider_id: 'kimi-code',
      subagent_model: 'kimi-k2.6',
    });
  });

  it('preserves a cross-provider target when the legacy model setter changes only the model', () => {
    store.setSubagentTarget('openai', 'kimi-code', 'kimi-k2.6');
    store.setSubagentModel('openai', 'kimi-k2.5');

    expect(store.getSubagentTarget('openai')).toEqual({
      providerId: 'kimi-code',
      modelId: 'kimi-k2.5',
    });
  });

  it('clears the target when provider and model return to session defaults', () => {
    store.setSubagentTarget('openai', 'kimi-code', 'kimi-k2.6');
    store.setSubagentTarget('openai', null, null);

    expect(store.getSubagentTarget('openai')).toBeNull();
    expect(store.getProvider('openai')!.extra.subagent_provider_id).toBeUndefined();
    expect(store.getProvider('openai')!.extra.subagent_model).toBeUndefined();
  });
});
