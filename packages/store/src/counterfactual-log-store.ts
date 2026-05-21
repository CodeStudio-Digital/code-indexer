/**
 * CounterfactualLogStore — CRUD over `counterfactual_logs` (migration 084).
 *
 * Two usage patterns:
 *   1. ShadowTrafficSideEffect inserts a row when it runs a variant.
 *   2. A feedback collector updates `true_outcome_json` later when it
 *      observes the real-world outcome (master spawned this role, user
 *      accepted this suggestion, …).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface CounterfactualLogRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  pipeline_name: string;
  shadow_variant: string;
  query_hash: string;
  production_choice_json: string | null;
  shadow_prediction_json: string | null;
  true_outcome_json: string | null;
  outcome_confidence: number | null;
  outcome_observed_at: string | null;
  created_at: string;
}

export interface CounterfactualLogInsert {
  session_id?: number | null;
  company_session_id?: number | null;
  pipeline_name: string;
  shadow_variant: string;
  query_hash: string;
  production_choice?: unknown;
  shadow_prediction?: unknown;
}

export interface OutcomeUpdate {
  id: number;
  true_outcome: unknown;
  outcome_confidence?: number;
}

export class CounterfactualLogStore {
  constructor(private db: DB) {}

  insert(row: CounterfactualLogInsert): number {
    const result = this.db
      .prepare(
        `INSERT INTO counterfactual_logs (
           session_id, company_session_id, pipeline_name, shadow_variant,
           query_hash, production_choice_json, shadow_prediction_json
         ) VALUES (
           @session_id, @company_session_id, @pipeline_name, @shadow_variant,
           @query_hash, @production_choice_json, @shadow_prediction_json
         )`,
      )
      .run({
        session_id: row.session_id ?? null,
        company_session_id: row.company_session_id ?? null,
        pipeline_name: row.pipeline_name,
        shadow_variant: row.shadow_variant,
        query_hash: row.query_hash,
        production_choice_json: row.production_choice != null ? JSON.stringify(row.production_choice) : null,
        shadow_prediction_json: row.shadow_prediction != null ? JSON.stringify(row.shadow_prediction) : null,
      });
    return Number(result.lastInsertRowid);
  }

  /** Backfill the observed outcome for a previously-logged shadow row. */
  recordOutcome(update: OutcomeUpdate): boolean {
    const result = this.db
      .prepare(
        `UPDATE counterfactual_logs
            SET true_outcome_json   = ?,
                outcome_confidence  = ?,
                outcome_observed_at = datetime('now')
          WHERE id = ?`,
      )
      .run(JSON.stringify(update.true_outcome), update.outcome_confidence ?? null, update.id);
    return Number(result.changes) > 0;
  }

  /** Rows still waiting for an outcome (for the feedback collector). */
  listPending(opts: { pipelineName?: string; limit?: number } = {}): CounterfactualLogRow[] {
    const where: string[] = ['true_outcome_json IS NULL'];
    const params: Record<string, unknown> = {};
    if (opts.pipelineName) { where.push('pipeline_name = @pipelineName'); params.pipelineName = opts.pipelineName; }
    const limit = opts.limit ?? 500;
    return this.db
      .prepare(
        `SELECT * FROM counterfactual_logs
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ${limit}`,
      )
      .all(params) as CounterfactualLogRow[];
  }

  list(opts: { pipelineName?: string; shadowVariant?: string; since?: string; limit?: number } = {}): CounterfactualLogRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.pipelineName)  { where.push('pipeline_name = @pipelineName'); params.pipelineName = opts.pipelineName; }
    if (opts.shadowVariant) { where.push('shadow_variant = @shadowVariant'); params.shadowVariant = opts.shadowVariant; }
    if (opts.since)         { where.push('created_at >= @since'); params.since = opts.since; }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 500;
    return this.db
      .prepare(
        `SELECT * FROM counterfactual_logs ${whereSql}
         ORDER BY created_at DESC
         LIMIT ${limit}`,
      )
      .all(params) as CounterfactualLogRow[];
  }

  stats(opts: { since?: string } = {}): {
    totalRows: number;
    withOutcome: number;
    pendingOutcome: number;
    perVariant: Array<{ pipeline_name: string; shadow_variant: string; count: number; with_outcome: number }>;
  } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(true_outcome_json) AS with_outcome
         FROM counterfactual_logs ${whereSql}`,
      )
      .get(params) as { total: number; with_outcome: number };
    const perVariant = this.db
      .prepare(
        `SELECT pipeline_name, shadow_variant,
                COUNT(*) AS count,
                COUNT(true_outcome_json) AS with_outcome
         FROM counterfactual_logs ${whereSql}
         GROUP BY pipeline_name, shadow_variant
         ORDER BY pipeline_name, shadow_variant`,
      )
      .all(params) as Array<{ pipeline_name: string; shadow_variant: string; count: number; with_outcome: number }>;
    return {
      totalRows: row.total,
      withOutcome: row.with_outcome,
      pendingOutcome: row.total - row.with_outcome,
      perVariant,
    };
  }

  pruneOlderThan(cutoff: string): number {
    const result = this.db
      .prepare('DELETE FROM counterfactual_logs WHERE created_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }
}
