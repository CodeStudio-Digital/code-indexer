/**
 * Migration 111 — model_prices: per-model token pricing for cost telemetry.
 *
 * Feeds estimateCost() (packages/code-agent/src/providers/pricing-cache.ts)
 * through the in-memory price cache hydrated on server startup. Rows come
 * from three kinds of source (column `source`): network refreshers
 * ('openrouter', 'litellm'), the offline seed of the hardcoded table
 * ('hardcoded'), and operator pins ('manual'). The refresh job overwrites
 * only its OWN source; 'manual'/'hardcoded' rows are never touched by a
 * network refresh.
 *
 * Unit: USD per 1,000,000 tokens (matches ModelPricing in pricing.ts).
 * Per-token sources (OpenRouter) are multiplied by 1e6 at normalization so
 * the DB and the cache speak one unit.
 *
 * `provider` uses '' (empty string) as the "cross-provider" sentinel rather
 * than NULL: SQLite treats NULLs as DISTINCT inside a UNIQUE constraint,
 * which would silently defeat both UNIQUE(provider, model_id, source) and the
 * ON CONFLICT upserts. With '' the constraint and upserts behave normally.
 *
 * Scope note: this table holds CURRENT prices (one row per model+source).
 * Point-in-time costing (re-pricing an old turn at the rate that applied
 * then) is a deliberate non-goal — the backfill re-prices history at today's
 * rate. If needed later, snapshot the price into coder_turn_telemetry at
 * persist time (the token columns are already there).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const modelPrices111: Migration = {
  version: 111,
  name: 'model_prices',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_prices (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        provider             TEXT NOT NULL DEFAULT '',
        model_id             TEXT NOT NULL,
        input_per_mtok       REAL,
        output_per_mtok      REAL,
        cache_read_per_mtok  REAL,
        cache_write_per_mtok REAL,
        currency             TEXT NOT NULL DEFAULT 'USD',
        source               TEXT NOT NULL,
        source_model_ref     TEXT,
        fetched_at           TEXT,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, model_id, source)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_prices_model
        ON model_prices(model_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_prices_source
        ON model_prices(source);
    `);
  },
};
