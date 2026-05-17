/**
 * Migration 047 — QA persistence path + Kanban linkage.
 *
 * Closes the gaps that forced the user to babysit the dashboard during
 * a QA run (ref: session 68):
 *
 *   - `qa_test_runs.report_persisted_path`: absolute host path where the
 *     run's `playwright-report/` + `test-results/` were copied to after
 *     the suite completed. Lets `/qa/playwright-report` and
 *     `/qa/artifact` keep serving evidence even after the sandbox has
 *     been destroyed.
 *
 *   - `qa_test_runs.kanban_feature_card_id`: optional id of the "QA: …"
 *     feature card the run is auditing. The kanban-bridge auto-moves
 *     this card between `in_progress` and `done` based on run results.
 *
 *   - `qa_test_results.summary_md_path`: workspace-relative path to the
 *     per-test markdown the reporter writes (steps, console, attachments).
 *     The dashboard renders this in the run detail modal so the operator
 *     has a textual trail for every test, pass or fail.
 *
 *   - `qa_test_results.kanban_card_id`: id of the auto-created bug card
 *     for failed/timed-out/interrupted tests. Idempotent — the bridge
 *     reuses the same card across runs of the same `<suite>:<test>` and
 *     just appends a comment when the failure recurs.
 *
 * Backfill: every existing row gets NULL for the new columns. Indexes
 * cover the two hot reads from the bridge (find existing bug card by
 * test) and the dashboard (jump from result row to its kanban card).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const qaKanbanAndPersistedPath047 = {
  version: 47,
  name: 'qa_kanban_and_persisted_path',
  up(db: DB) {
    db.exec(`
      ALTER TABLE qa_test_runs ADD COLUMN report_persisted_path TEXT;
      ALTER TABLE qa_test_runs ADD COLUMN kanban_feature_card_id INTEGER
        REFERENCES kanban_cards(id) ON DELETE SET NULL;
      ALTER TABLE qa_test_runs ADD COLUMN last_error TEXT;

      ALTER TABLE qa_test_results ADD COLUMN summary_md_path TEXT;
      ALTER TABLE qa_test_results ADD COLUMN kanban_card_id INTEGER
        REFERENCES kanban_cards(id) ON DELETE SET NULL;

      CREATE INDEX idx_qa_results_kanban
        ON qa_test_results(kanban_card_id);
    `);
  },
};
