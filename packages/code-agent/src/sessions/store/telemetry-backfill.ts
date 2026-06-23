import type { Database as DB } from 'better-sqlite3';
import { estimateCost } from '@mcp/code-agent/providers/pricing-cache.js';

/**
 * Recompute `estimated_cost_usd` for historical coder_turn_telemetry rows
 * using the CURRENT price cache. Run this after the price cache is hydrated
 * (server runtime, never as a migration — a migration runs before the cache
 * exists). Idempotent: re-running with the same prices writes nothing new.
 */
export interface BackfillOptions {
  /** Rows per keyset page (default 500). */
  batchSize?: number;
  /** Only touch rows with NULL cost (skip already-priced). */
  onlyNullCost?: boolean;
  /** Compute the report without writing. */
  dryRun?: boolean;
}

export interface BackfillResult {
  scanned: number;
  /** Rows whose stored cost changed (or WOULD change, in dryRun). */
  updated: number;
  /** Rows that end with a non-null cost. */
  nowPriced: number;
  /** Rows that end with NULL cost (no price resolvable). */
  stillUnpriced: number;
  byModel: Array<{ model: string; updated: number; still_unpriced: number }>;
}

interface TurnRow {
  id: number;
  provider: string | null;
  model: string | null;
  request_api_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  estimated_cost_usd: number | null;
}

function floatEq(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-9;
}

export function backfillTurnCosts(db: DB, opts: BackfillOptions = {}): BackfillResult {
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const onlyNull = opts.onlyNullCost ?? false;
  const dryRun = opts.dryRun ?? false;

  const select = db.prepare(
    `SELECT id, provider, model, request_api_model,
            input_tokens, output_tokens,
            cache_read_input_tokens, cache_creation_input_tokens, estimated_cost_usd
       FROM coder_turn_telemetry
      WHERE id > ?${onlyNull ? ' AND estimated_cost_usd IS NULL' : ''}
      ORDER BY id LIMIT ?`,
  );
  const update = db.prepare(`UPDATE coder_turn_telemetry SET estimated_cost_usd = ? WHERE id = ?`);

  let scanned = 0;
  let updated = 0;
  let nowPriced = 0;
  let stillUnpriced = 0;
  const byModel = new Map<string, { updated: number; still_unpriced: number }>();

  // Keyset pagination by id — stable under concurrent inserts and never
  // re-sees a row, so an onlyNull pass can't loop on rows it just filled.
  let lastId = 0;
  for (;;) {
    const rows = select.all(lastId, batchSize) as TurnRow[];
    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const r of rows) {
        scanned++;
        lastId = r.id;
        // Key on request_api_model first — the same COALESCE the dashboard
        // groups by — so live and backfilled rows price identically.
        const model = r.request_api_model ?? r.model;
        const cost = estimateCost(r.provider, model, {
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_read_input_tokens: r.cache_read_input_tokens,
          cache_creation_input_tokens: r.cache_creation_input_tokens,
        });
        const newVal = cost > 0 ? cost : null;
        const bucketKey = model ?? '(null)';
        const bucket = byModel.get(bucketKey) ?? { updated: 0, still_unpriced: 0 };
        if (newVal == null) {
          stillUnpriced++;
          bucket.still_unpriced++;
        } else {
          nowPriced++;
        }
        if (!floatEq(newVal, r.estimated_cost_usd)) {
          updated++;
          if (newVal != null) bucket.updated++;
          if (!dryRun) update.run(newVal, r.id);
        }
        byModel.set(bucketKey, bucket);
      }
    });
    tx();

    if (rows.length < batchSize) break;
  }

  return {
    scanned,
    updated,
    nowPriced,
    stillUnpriced,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, updated: v.updated, still_unpriced: v.still_unpriced }))
      .sort((a, b) => b.updated - a.updated),
  };
}
