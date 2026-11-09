import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { ProviderStore } from '../provider-store.js';

describe('persisted OpenAI API catalog repair', () => {
  let db: CodeIndexDB, store: ProviderStore, directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'openai-catalog-'));
    db = new CodeIndexDB(join(directory, 'index.db'));
    store = new ProviderStore(db.raw());
    store.upsertProvider({ id: 'my-api', name: 'API', kind: 'openai', api_key: 'fixture', base_url: 'https://api.openai.com/v1' });
    store.replaceModelsFromSource('my-api', 'live', [
      { model_id: 'gpt-5.5', name: 'gpt-5.5', context_window: 272_000 },
      { model_id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', context_window: 372_000 },
      { model_id: 'gpt-6-astra', name: 'gpt-6-astra' },
    ]);
  });
  afterEach(() => { store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('repairs old/null API limits and efforts without writing to the catalog or using the network', () => {
    const before = db.raw().prepare('SELECT * FROM provider_models WHERE provider_id = ?').all('my-api');
    const models = store.listModels('my-api');
    expect(models.every(model => model.context_window === 1_050_000 && model.can_reason)).toBe(true);
    expect(models.every(model => model.supported_reasoning_levels?.includes('high'))).toBe(true);
    expect(models.find(model => model.model_id === 'gpt-6-astra')?.supported_reasoning_levels).not.toContain('none');
    expect(store.listAllModels().filter(model => model.provider_id === 'my-api')).toEqual(models);
    expect(db.raw().prepare('SELECT * FROM provider_models WHERE provider_id = ?').all('my-api')).toEqual(before);
  });

  it('preserves explicit context, effort, output and enablement choices across refresh', () => {
    store.updateModel('my-api', 'gpt-5.5', '', { context_window: 272_000, default_reasoning_level: 'high', default_max_tokens: 16_000, enabled: false });
    store.replaceModelsFromSource('my-api', 'live', [{ model_id: 'gpt-5.5', name: 'gpt-5.5', context_window: 1_050_000,
      supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium', default_max_tokens: 128_000 }]);
    expect(store.listModels('my-api')[0]).toMatchObject({ context_window: 272_000, context_window_overridden: true,
      default_reasoning_level: 'high', default_max_tokens: 16_000, enabled: false });
    expect(store.listModels('my-api', true)).toHaveLength(0);
    store.updateModel('my-api', 'gpt-5.5', '', { context_window: null, default_reasoning_level: null, default_max_tokens: null });
    expect(store.listModels('my-api')[0]).toMatchObject({ context_window: 1_050_000, default_reasoning_level: null, default_max_tokens: null });
  });

  it.each([
    ['oauth', 'openai-chatgpt', null],
    ['proxy', 'openai', 'https://proxy.example.invalid/v1'],
  ])('does not change the %s account catalog', (id, kind, base_url) => {
    store.upsertProvider({ id: id!, name: id!, kind: kind!, base_url });
    store.replaceModelsFromSource(id!, 'live', [{ model_id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', context_window: 372_000 }]);
    expect(store.listModels(id!)[0]).toMatchObject({ context_window: 372_000, supported_reasoning_levels: null });
  });

  it('retains manual and advertised limits instead of replacing every API row', () => {
    store.replaceModelsFromSource('my-api', 'manual', [{ model_id: 'gpt-6.1-sol', name: 'Manual', context_window: 272_000 }]);
    store.replaceModelsFromSource('my-api', 'live', [{ model_id: 'gpt-6-astra', name: 'Advertised', context_window: 800_000 }]);
    expect(store.listModels('my-api').find(model => model.name === 'Manual')?.context_window).toBe(272_000);
    expect(store.listModels('my-api').find(model => model.name === 'Advertised')?.context_window).toBe(800_000);
  });
});
