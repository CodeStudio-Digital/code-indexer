/**
 * Migration 111 — model_prices.
 *
 * Pin invariants:
 *   - Table + columns exist; idempotent up().
 *   - replacePricesFromSource round-trips and is scoped to its own source.
 *   - 'manual'/'hardcoded' rows survive a network refresh.
 *   - seedHardcodedPricesIfMissing is idempotent (second run inserts 0).
 *   - source is part of the UNIQUE key, so two sources coexist for one model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { modelPrices111 } from '../111_model_prices.js';
import * as modelPrices from '../../provider/model-prices.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  modelPrices111.up(db);
});

afterEach(() => {
  db.close();
});

describe('migration 111 — model_prices', () => {
  it('creates model_prices with expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(model_prices)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const n of ['provider', 'model_id', 'input_per_mtok', 'output_per_mtok', 'cache_read_per_mtok', 'cache_write_per_mtok', 'currency', 'source', 'fetched_at', 'updated_at']) {
      expect(names.has(n), `missing column ${n}`).toBe(true);
    }
  });

  it('is idempotent — second up() run is a no-op', () => {
    expect(() => modelPrices111.up(db)).not.toThrow();
  });

  it('replacePricesFromSource round-trips and is scoped to its source', () => {
    modelPrices.replacePricesFromSource(db, 'litellm', [
      { provider: '', model_id: 'gpt-4o', input_per_mtok: 2.5, output_per_mtok: 10 },
    ]);
    modelPrices.replacePricesFromSource(db, 'openrouter', [
      { provider: '', model_id: 'gpt-4o', input_per_mtok: 2.6, output_per_mtok: 10.1 },
    ]);
    const rows = modelPrices.listAllPrices(db).filter((r) => r.model_id === 'gpt-4o');
    // Both sources coexist (source is part of the UNIQUE key).
    expect(rows.map((r) => r.source).sort()).toEqual(['litellm', 'openrouter']);

    // Re-running litellm replaces only litellm rows.
    modelPrices.replacePricesFromSource(db, 'litellm', [
      { provider: '', model_id: 'claude-opus-4-8', input_per_mtok: 15, output_per_mtok: 75 },
    ]);
    const after = modelPrices.listAllPrices(db);
    expect(after.some((r) => r.source === 'litellm' && r.model_id === 'gpt-4o')).toBe(false);
    expect(after.some((r) => r.source === 'openrouter' && r.model_id === 'gpt-4o')).toBe(true);
  });

  it('refuses protected sources outright', () => {
    const res = modelPrices.replacePricesFromSource(db, 'manual', [
      { provider: '', model_id: 'x', input_per_mtok: 1, output_per_mtok: 2 },
    ]);
    expect(res.skipped_protected).toBe(1);
    expect(res.inserted).toBe(0);
  });

  it('manual + hardcoded rows survive a network refresh', () => {
    modelPrices.upsertManualPrice(db, { provider: '', model_id: 'gpt-4o', input_per_mtok: 1, output_per_mtok: 1 });
    modelPrices.seedHardcodedPricesIfMissing(db, [{ provider: '', model_id: 'gpt-4o', input_per_mtok: 2.5, output_per_mtok: 10 }]);
    modelPrices.replacePricesFromSource(db, 'litellm', [{ provider: '', model_id: 'gpt-4o', input_per_mtok: 2.0, output_per_mtok: 8 }]);
    const rows = modelPrices.listAllPrices(db).filter((r) => r.model_id === 'gpt-4o');
    const sources = new Set(rows.map((r) => r.source));
    expect(sources.has('manual')).toBe(true);
    expect(sources.has('hardcoded')).toBe(true);
    expect(sources.has('litellm')).toBe(true);
  });

  it('seedHardcodedPricesIfMissing is idempotent', () => {
    const seed = [{ provider: '', model_id: 'gpt-4o', input_per_mtok: 2.5, output_per_mtok: 10 }];
    expect(modelPrices.seedHardcodedPricesIfMissing(db, seed)).toBe(1);
    expect(modelPrices.seedHardcodedPricesIfMissing(db, seed)).toBe(0);
  });
});
