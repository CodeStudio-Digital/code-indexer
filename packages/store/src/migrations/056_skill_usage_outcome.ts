/**
 * Migration 056 — Skill usage telemetry: outcome, error code, agent run.
 *
 * Adds three columns to `skill_usage_log` so the dashboard can answer
 * "which skills are failing, with which error codes, and in which agent
 * runs?" instead of just "how often is this skill called?".
 *
 * Without this telemetry the operator has no visibility into whether a
 * skill is doing its job or routinely producing garbage that gets
 * rejected downstream (e.g. `ds-extractor` repeatedly emitting manifests
 * that fail `vocab.leak`). The skill-store's `getSkillUsageStats` reads
 * these columns to surface success_rate and top error codes.
 *
 * All columns are nullable so old rows keep the same shape — they just
 * report unknown outcomes.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const skillUsageOutcome = {
  version: 56,
  name: 'skill_usage_outcome',
  up(db: DB) {
    db.exec(`
      ALTER TABLE skill_usage_log ADD COLUMN outcome TEXT;
      ALTER TABLE skill_usage_log ADD COLUMN error_code TEXT;
      ALTER TABLE skill_usage_log ADD COLUMN agent_run_id INTEGER;

      CREATE INDEX IF NOT EXISTS idx_sul_outcome
        ON skill_usage_log(skill_id, outcome);
    `);
  },
};
