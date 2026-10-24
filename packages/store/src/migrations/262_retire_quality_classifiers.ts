import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const RETIRED_PIPELINES = [
  'quality_delivery',
  'quality_off_topic',
  'quality_completeness',
  'quality_code',
  'quality_policy',
  'quality_tool_misuse',
] as const;

function hasTable(db: DB, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table);
}

/** Remove the retired semantic-quality evaluator, its bindings and stored output. */
export const retireQualityClassifiers262: Migration = {
  version: 262,
  name: 'retire_quality_classifiers',
  up(db: DB): void {
    if (hasTable(db, 'pipeline_provider_bindings')) {
      const placeholders = RETIRED_PIPELINES.map(() => '?').join(', ');
      db.prepare(
        `DELETE FROM pipeline_provider_bindings WHERE pipeline_name IN (${placeholders})`,
      ).run(...RETIRED_PIPELINES);
    }

    db.exec(`
      DROP TABLE IF EXISTS quality_interventions;
      DROP TABLE IF EXISTS quality_classifications;
    `);
  },
};
