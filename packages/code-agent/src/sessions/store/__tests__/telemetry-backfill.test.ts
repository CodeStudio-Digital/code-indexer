/**
 * Backfill — recomputes estimated_cost_usd for historical turns using the
 * current price cache. Pins: idempotency, dryRun (no writes), the
 * nowPriced/stillUnpriced split, and that request_api_model is preferred
 * over model (matching the dashboard's COALESCE grouping).
 *
 * Uses the static MODEL_PRICING table (no DB hydration) so the expected
 * numbers are deterministic: claude-opus-4-7 = input 15 / output 75 per Mtok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { backfillTurnCosts } from '../telemetry-backfill.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function createTable(d: DB): void {
  d.exec(`
    CREATE TABLE coder_turn_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT, model TEXT, request_api_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      estimated_cost_usd REAL
    );
  `);
}

function insert(d: DB, row: Partial<Record<string, unknown>>): void {
  d.prepare(
    `INSERT INTO coder_turn_telemetry
       (provider, model, request_api_model, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, estimated_cost_usd)
     VALUES (@provider, @model, @request_api_model, @input_tokens, @output_tokens,
             @cache_read_input_tokens, @cache_creation_input_tokens, @estimated_cost_usd)`,
  ).run({
    provider: null, model: null, request_api_model: null,
    input_tokens: null, output_tokens: null,
    cache_read_input_tokens: null, cache_creation_input_tokens: null,
    estimated_cost_usd: null,
    ...row,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  createTable(db);
});
afterEach(() => db.close());

describe('backfillTurnCosts', () => {
  it('prices NULL-cost rows on a known model and leaves unknown ones NULL', () => {
    insert(db, { provider: 'anthropic', model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 1_000_000 });
    insert(db, { provider: 'x', model: 'totally-unknown-zzz', input_tokens: 500 });

    const res = backfillTurnCosts(db);
    expect(res.scanned).toBe(2);
    expect(res.nowPriced).toBe(1);
    expect(res.stillUnpriced).toBe(1);
    expect(res.updated).toBe(1);

    const priced = db.prepare(`SELECT estimated_cost_usd FROM coder_turn_telemetry WHERE model = 'claude-opus-4-7'`).get() as { estimated_cost_usd: number };
    expect(priced.estimated_cost_usd).toBeCloseTo(90, 6);
  });

  it('is idempotent — a second run changes nothing', () => {
    insert(db, { provider: 'anthropic', model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0 });
    backfillTurnCosts(db);
    const second = backfillTurnCosts(db);
    expect(second.updated).toBe(0);
  });

  it('dryRun computes the report without writing', () => {
    insert(db, { provider: 'anthropic', model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0 });
    const res = backfillTurnCosts(db, { dryRun: true });
    expect(res.updated).toBe(1);
    const row = db.prepare(`SELECT estimated_cost_usd FROM coder_turn_telemetry`).get() as { estimated_cost_usd: number | null };
    expect(row.estimated_cost_usd).toBeNull(); // unchanged
  });

  it('prefers request_api_model over model', () => {
    // model is unknown, but request_api_model is priceable → should price.
    insert(db, { provider: 'anthropic', model: 'internal-alias', request_api_model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0 });
    const res = backfillTurnCosts(db);
    expect(res.nowPriced).toBe(1);
    expect(res.byModel[0].model).toBe('claude-opus-4-7');
  });

  it('onlyNullCost skips already-priced rows', () => {
    insert(db, { provider: 'anthropic', model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0, estimated_cost_usd: 999 });
    const res = backfillTurnCosts(db, { onlyNullCost: true });
    expect(res.scanned).toBe(0);
    const row = db.prepare(`SELECT estimated_cost_usd FROM coder_turn_telemetry`).get() as { estimated_cost_usd: number };
    expect(row.estimated_cost_usd).toBe(999); // untouched
  });
});
