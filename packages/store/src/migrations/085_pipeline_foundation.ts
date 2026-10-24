/**
 * Migration 085 — Pipeline foundation: telemetry + provider bindings.
 *
 * Previously authored as version 080; renumbered to 085 because version
 * 080 was claimed on some development databases by an unrelated
 * `preview_strategy` entry, causing the runner to skip the pipeline
 * tables (the version marker was set even though the SQL came from
 * elsewhere). 085 is unused on every known DB, so this lands cleanly.
 *
 * Introduces the persistent layer that supports the new candidate-pipeline
 * framework (inspired by xai-org/x-algorithm's candidate-pipeline crate):
 *
 *   1. `pipeline_telemetry` — per-stage execution traces emitted by every
 *      pipeline component (Source / Hydrator / Filter / Scorer / Selector /
 *      SideEffect). Bucketed latency and size dimensions follow the
 *      `Bucket0To50` / `Bucket50To500` / `Bucket500To2500` convention from
 *      `candidate-pipeline/*.rs` (#[xai_stats_macro::receive_stats(...)]).
 *
 *   2. `pipeline_provider_bindings` — hierarchical (global / template /
 *      session) overrides of which provider+model+config a given pipeline
 *      uses for a given role (embedder / classifier / reranker / scorer_llm).
 *      Resolved at runtime by PipelineProviderResolver — never hard-coded.
 *
 * Both tables are additive. Safe on fresh and existing databases.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pipelineFoundation085: Migration = {
  version: 85,
  name: 'pipeline_foundation',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_telemetry (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        INTEGER,
        company_session_id INTEGER,
        pipeline_name     TEXT NOT NULL,
        stage             TEXT NOT NULL,
        component_name    TEXT NOT NULL,
        duration_ms       REAL NOT NULL,
        duration_bucket   TEXT NOT NULL,
        candidates_in     INTEGER,
        candidates_out    INTEGER,
        size_bucket       TEXT,
        cache_hits        INTEGER NOT NULL DEFAULT 0,
        cache_misses      INTEGER NOT NULL DEFAULT 0,
        errors            INTEGER NOT NULL DEFAULT 0,
        diag_json         TEXT,
        trace_sampled     INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_telemetry_session
        ON pipeline_telemetry(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_pipeline_telemetry_company_session
        ON pipeline_telemetry(company_session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_pipeline_telemetry_pipeline
        ON pipeline_telemetry(pipeline_name, created_at);

      CREATE INDEX IF NOT EXISTS idx_pipeline_telemetry_stage
        ON pipeline_telemetry(pipeline_name, stage, created_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_provider_bindings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_name   TEXT NOT NULL,
        binding_role    TEXT NOT NULL,
        provider_id     TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id        TEXT NOT NULL,
        model_mode      TEXT NOT NULL DEFAULT '',
        config_json     TEXT NOT NULL DEFAULT '{}',
        scope_type      TEXT NOT NULL,
        scope_id        INTEGER,
        enabled         INTEGER NOT NULL DEFAULT 1,
        priority        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(pipeline_name, binding_role, scope_type, scope_id, provider_id, model_id, model_mode)
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_bindings_lookup
        ON pipeline_provider_bindings(pipeline_name, binding_role, scope_type, scope_id, enabled, priority);

      CREATE INDEX IF NOT EXISTS idx_pipeline_bindings_provider
        ON pipeline_provider_bindings(provider_id, enabled);
    `);
  },
};
