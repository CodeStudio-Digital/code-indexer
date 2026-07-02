/**
 * `QaTestRunStore` — concrete implementation of `IQaTestRunStore`,
 * persisted via `better-sqlite3` against the schema set up by migration
 * 043. Owns no business logic; just CRUD with a couple of guards
 * (idempotent completion) so the routes / tools stay thin.
 *
 * Constructor accepts either a path (managed connection) or a shared
 * handle — same dual-mode pattern used by `SkillStore` and the Company
 * stores. Sharing the handle is what `deps.ts` does in production to
 * avoid SQLite WAL contention.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  QaRun,
  QaRunCompletion,
  QaRunInsert,
  QaRunStatus,
  QaRunTrigger,
} from '../types.js';
import type { IQaTestRunStore } from './interfaces.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

interface QaRunRaw {
  id: number;
  company_session_id: number;
  agent_run_id: number | null;
  suite: string;
  service_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  trigger: string;
  report_persisted_path: string | null;
  kanban_feature_card_id: number | null;
  last_error: string | null;
  error_class: string | null;
  last_event_at: string | null;
  plan_gate: string | null;
}

function hydrate(r: QaRunRaw): QaRun {
  return {
    id: r.id,
    company_session_id: r.company_session_id,
    agent_run_id: r.agent_run_id,
    suite: r.suite,
    service_id: r.service_id,
    status: r.status as QaRunStatus,
    started_at: r.started_at,
    completed_at: r.completed_at,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    duration_ms: r.duration_ms,
    trigger: r.trigger as QaRunTrigger,
    report_persisted_path: r.report_persisted_path ?? null,
    kanban_feature_card_id: r.kanban_feature_card_id ?? null,
    last_error: r.last_error ?? null,
    error_class: r.error_class ?? null,
    last_event_at: r.last_event_at ?? null,
    plan_gate: r.plan_gate ?? null,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class QaTestRunStore implements IQaTestRunStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  startRun(input: QaRunInsert): QaRun {
    const info = this.db
      .prepare(
        `INSERT INTO qa_test_runs
           (company_session_id, agent_run_id, suite, service_id, status, trigger, kanban_feature_card_id, plan_gate)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        input.company_session_id,
        input.agent_run_id,
        input.suite,
        input.service_id ?? 'main',
        input.trigger,
        input.kanban_feature_card_id ?? null,
        input.plan_gate ?? null,
      );
    const inserted = this.getRun(Number(info.lastInsertRowid));
    if (!inserted) {
      throw new Error('startRun: insert succeeded but row read returned null');
    }
    return inserted;
  }

  /**
   * Persist the host-side directory holding the run's `playwright-report/`
   * and `test-results/`. Called by the report-persistence helper after
   * a successful copy from the sandbox. Idempotent — re-setting the path
   * is safe (overwrites any prior value, which is the desired behaviour
   * if the run was re-persisted to a new location).
   */
  setReportPersistedPath(runId: number, absolutePath: string | null): void {
    this.db
      .prepare('UPDATE qa_test_runs SET report_persisted_path = ? WHERE id = ?')
      .run(absolutePath, runId);
  }

  /**
   * Count runs that finished with the watchdog's standard error message
   * inside the last `windowMs` for a given session. Powers the
   * "watchdog killed N runs in 24h" chip on the diagnostics panel.
   */
  countWatchdogKills(opts: { company_session_id: number; windowMs: number }): number {
    const seconds = Math.max(0, Math.floor(opts.windowMs / 1000));
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM qa_test_runs
         WHERE company_session_id = ?
           AND status = 'error'
           AND last_error IS NOT NULL
           AND last_error LIKE 'No events received from reporter%'
           AND completed_at >= datetime('now', ?)`,
      )
      .get(opts.company_session_id, `-${seconds} seconds`) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  completeRun(runId: number, completion: QaRunCompletion): QaRun | null {
    // Guard: only transition out of `running`. Calling complete on an
    // already-completed run is a no-op so the reporter's `onEnd` hook
    // is safe to retry on transient network failures.
    const existing = this.getRun(runId);
    if (!existing) return null;
    if (existing.status !== 'running') return existing;

    this.db
      .prepare(
        `UPDATE qa_test_runs
         SET status = ?, completed_at = datetime('now'),
             passed = ?, failed = ?, skipped = ?, duration_ms = ?,
             last_error = ?, error_class = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        completion.status,
        completion.passed,
        completion.failed,
        completion.skipped,
        completion.duration_ms,
        completion.last_error ?? null,
        completion.error_class ?? null,
        runId,
      );
    return this.getRun(runId);
  }

  /**
   * B7: mark reporter progress. Only touches rows still in `running`
   * so late/retried reporter POSTs after completion stay no-ops.
   */
  touchLastEvent(runId: number): void {
    this.db
      .prepare(
        `UPDATE qa_test_runs SET last_event_at = datetime('now')
         WHERE id = ? AND status = 'running'`,
      )
      .run(runId);
  }

  /** B7: every `running` run across all sessions (ChromeService hook). */
  listRunningRuns(): QaRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_test_runs WHERE status = 'running'
         ORDER BY started_at ASC, id ASC`,
      )
      .all() as QaRunRaw[];
    return rows.map(hydrate);
  }

  getRun(runId: number): QaRun | null {
    const row = this.db
      .prepare('SELECT * FROM qa_test_runs WHERE id = ?')
      .get(runId) as QaRunRaw | undefined;
    return row ? hydrate(row) : null;
  }

  listRuns(opts: {
    company_session_id: number;
    /** When set, restricts the result to one microservice. */
    service_id?: string;
    limit?: number;
    offset?: number;
  }): QaRun[] {
    const limit = clampLimit(opts.limit);
    const offset = Math.max(0, opts.offset ?? 0);
    if (opts.service_id) {
      const rows = this.db
        .prepare(
          `SELECT * FROM qa_test_runs
           WHERE company_session_id = ? AND service_id = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(opts.company_session_id, opts.service_id, limit, offset) as QaRunRaw[];
      return rows.map(hydrate);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_test_runs
         WHERE company_session_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(opts.company_session_id, limit, offset) as QaRunRaw[];
    return rows.map(hydrate);
  }

  getActiveRun(company_session_id: number, service_id?: string): QaRun | null {
    if (service_id) {
      const row = this.db
        .prepare(
          `SELECT * FROM qa_test_runs
           WHERE company_session_id = ? AND service_id = ? AND status = 'running'
           ORDER BY started_at DESC, id DESC
           LIMIT 1`,
        )
        .get(company_session_id, service_id) as QaRunRaw | undefined;
      return row ? hydrate(row) : null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM qa_test_runs
         WHERE company_session_id = ? AND status = 'running'
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      )
      .get(company_session_id) as QaRunRaw | undefined;
    return row ? hydrate(row) : null;
  }

  recoverStaleRuns(): { recovered: number } {
    // Idempotent at the SQL level: the WHERE clause makes a re-run
    // touch zero rows. Stamping `completed_at` lets the UI sort and
    // filter "ended" runs uniformly without a NULL-aware predicate.
    const info = this.db
      .prepare(
        `UPDATE qa_test_runs
         SET status = 'aborted',
             completed_at = datetime('now')
         WHERE status = 'running'`,
      )
      .run();
    return { recovered: typeof info.changes === 'number' ? info.changes : 0 };
  }

  /**
   * v4.4 watchdog support: list runs that have been `running` for
   * longer than `maxAgeMs` AND have received zero `qa_test_results`
   * rows. These are the "ghost" runs that produced 0/0/0 in session
   * 68 — the agent created the row, ran tests, but the reporter never
   * POST'd events (typically because `playwright.config.ts` was
   * customised in a way that broke the streaming reporter, or the
   * agent forgot to export `PLAYWRIGHT_QA_ENDPOINT`).
   *
   * The age check uses SQLite's `datetime('now', '-N seconds')` so
   * the value compares apples to apples with `started_at` (also UTC
   * via `datetime('now')`). Pure SQL — no clock injection needed for
   * tests; tests pass `maxAgeMs=0` to match every running row.
   *
   * B7: age is measured from the run's last PROGRESS — the later of
   * `started_at` and `last_event_at` — so a reporter that streamed a
   * `started`/heartbeat event recently resets the clock even before
   * the first `qa_test_results` row lands. `MAX(a, b)` in SQLite
   * returns NULL when any operand is NULL, hence the COALESCE.
   */
  findStaleRunningRuns(maxAgeMs: number): QaRun[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM qa_test_runs r
         WHERE r.status = 'running'
           AND MAX(r.started_at, COALESCE(r.last_event_at, r.started_at)) <= datetime('now', ?)
           AND NOT EXISTS (
             SELECT 1 FROM qa_test_results res WHERE res.run_id = r.id
           )
         ORDER BY r.started_at ASC, r.id ASC`,
      )
      .all(`-${Math.max(0, Math.floor(maxAgeMs / 1000))} seconds`) as QaRunRaw[];
    return rows.map(hydrate);
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(raw));
}
