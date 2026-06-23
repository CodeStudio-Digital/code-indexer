/**
 * Migration 084 — counterfactual logs.
 *
 * Captures shadow-traffic predictions: for X% of production requests,
 * variants of a pipeline run alongside the live one and log what they
 * would have produced. The live response is unaffected. Once an outcome
 * is observable (user accepted suggestion, master spawned this role, …)
 * the row's `true_outcome_json` is filled in.
 *
 * Drives long-term improvement: aggregated counterfactuals show whether
 * a variant beats production, justifying a rollout. Inspired by
 * `home-mixer/side_effects/phoenix_experiments_side_effect.rs:40-62`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const counterfactualLogs084: Migration = {
  version: 84,
  name: 'counterfactual_logs',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS counterfactual_logs (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id               INTEGER,
        company_session_id       INTEGER,
        pipeline_name            TEXT NOT NULL,
        shadow_variant           TEXT NOT NULL,         -- e.g. 'top_k=8' or 'weights_alt_a'
        query_hash               TEXT NOT NULL,
        production_choice_json   TEXT,
        shadow_prediction_json   TEXT,
        true_outcome_json        TEXT,                  -- filled later by feedback collector
        outcome_confidence       REAL,
        outcome_observed_at      TEXT,
        created_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_counterfactual_pipeline
        ON counterfactual_logs(pipeline_name, shadow_variant, created_at);

      CREATE INDEX IF NOT EXISTS idx_counterfactual_session
        ON counterfactual_logs(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_counterfactual_pending_outcome
        ON counterfactual_logs(pipeline_name, true_outcome_json)
        WHERE true_outcome_json IS NULL;
    `);
  },
};
