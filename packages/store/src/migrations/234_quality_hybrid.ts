/** Migration 234 — terminal delivery assessment + deterministic runtime incidents. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function addColumn(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const qualityHybrid234: Migration = {
  version: 234,
  name: 'quality_hybrid',
  up(db: DB): void {
    // Project databases intentionally trim this central table.
    if (tableExists(db, 'quality_classifications')) {
      addColumn(db, 'quality_classifications', 'assessment_id', 'TEXT');
      addColumn(db, 'quality_classifications', 'round_message_id', 'INTEGER');
      addColumn(db, 'quality_classifications', 'scope', `TEXT NOT NULL DEFAULT 'legacy_turn'`);
      addColumn(db, 'quality_classifications', 'source', `TEXT NOT NULL DEFAULT 'legacy_llm'`);
      addColumn(db, 'quality_classifications', 'action_taken', `TEXT NOT NULL DEFAULT 'none'`);
      addColumn(db, 'quality_classifications', 'evidence_json', 'TEXT');
      addColumn(db, 'quality_classifications', 'tokens_in', 'INTEGER');
      addColumn(db, 'quality_classifications', 'tokens_out', 'INTEGER');
      addColumn(db, 'quality_classifications', 'provider_requests', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_quality_assessment
          ON quality_classifications(assessment_id, classifier_name);
        CREATE INDEX IF NOT EXISTS idx_quality_scope_created
          ON quality_classifications(scope, source, created_at);
        CREATE INDEX IF NOT EXISTS idx_quality_round
          ON quality_classifications(round_message_id, created_at);
      `);
    }

    if (tableExists(db, 'pipeline_provider_bindings')) {
      const exists = db.prepare(
        `SELECT 1 FROM pipeline_provider_bindings
         WHERE pipeline_name='quality_delivery' AND binding_role='classifier' LIMIT 1`,
      ).get();
      if (!exists) {
        db.exec(`
          INSERT INTO pipeline_provider_bindings (
            pipeline_name, binding_role, provider_id, model_id, model_mode,
            config_json, scope_type, scope_id, enabled, priority
          )
          SELECT 'quality_delivery', binding_role, provider_id, model_id, model_mode,
                 config_json, scope_type, scope_id, enabled, priority
          FROM pipeline_provider_bindings
          WHERE pipeline_name='quality_completeness' AND binding_role='classifier'
        `);
      }
    }
  },
};
