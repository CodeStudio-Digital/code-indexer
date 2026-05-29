/**
 * Migration 090 — `quality_interventions`.
 *
 * Closes the feedback loop on Wires #1, #2, and #5: every time the quality
 * pipeline injects a corrective signal (nudge text into the system prompt,
 * planning intervention header, policy-block error), this table records:
 *
 *   - WHY it fired (snapshot of triggering verdicts)
 *   - WHEN (turn number + timestamp)
 *   - WHAT happened next (verdicts on the FOLLOWING classified turn,
 *     backfilled when those arrive)
 *   - HOW that compared (`improved` / `unchanged` / `worsened` —
 *     computed via `computeOutcome` in `feedback-builder.ts`)
 *
 * Without this table the v1 implementation fired blind: we knew when a
 * nudge was emitted, but never measured whether it actually improved the
 * next turn. The dashboard panel "Intervention effectiveness" reads from
 * this table to surface improved-rate per intervention type so operators
 * can tune the prompts / thresholds based on real evidence.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const qualityInterventions090: Migration = {
  version: 90,
  name: 'quality_interventions',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_interventions (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id               INTEGER,
        company_session_id       INTEGER,
        agent_run_id             INTEGER,
        turn_fired               INTEGER NOT NULL,
        intervention_type        TEXT NOT NULL,
            -- 'nudge' | 'planning' | 'policy_block' | 'board_alert'
            -- | 'nudge_suppressed' | 'nudge_holdout'  (free text — no CHECK)
        triggering_verdicts_json TEXT NOT NULL,
            -- snapshot: [{ classifierName, verdict, confidence, reason }, ...]
        triggering_classifiers   TEXT NOT NULL,
            -- CSV: 'completeness,tool_misuse' — for quick filtering without parsing JSON
        next_turn_verdicts_json  TEXT,
            -- backfilled by the global classifier runner when the next classified turn lands
        outcome                  TEXT,
            -- 'improved' | 'unchanged' | 'worsened' | 'pending'
            -- nullable until backfill happens
        outcome_recorded_at      TEXT,
        nudge_chars              INTEGER,
            -- size of injected text (chars). Lets us monitor cost added per intervention.
        created_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Lookup by (session, turn) — the backfill path queries
      -- "interventions for THIS session where turn_fired = currentTurn - 1".
      CREATE INDEX IF NOT EXISTS idx_quality_interventions_session
        ON quality_interventions(session_id, turn_fired);

      -- Dashboard aggregation: stats per (intervention_type, outcome)
      -- within a time window.
      CREATE INDEX IF NOT EXISTS idx_quality_interventions_outcome
        ON quality_interventions(intervention_type, outcome, created_at);
    `);
  },
};
