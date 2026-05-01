/**
 * `QaTestResultStore` — per-test outcome rows, written by the Playwright
 * reporter and read by the RunDetailModal + flaky-badge derivations.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  QaTestResult,
  QaTestResultInsert,
  QaTestStatus,
} from '../types.js';
import type { IQaTestResultStore } from './interfaces.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

interface QaResultRaw {
  id: number;
  run_id: number;
  spec_file: string;
  test_name: string;
  status: string;
  duration_ms: number | null;
  error: string | null;
  trace_path: string | null;
  screenshot_path: string | null;
  video_path: string | null;
  summary_md_path: string | null;
  kanban_card_id: number | null;
  created_at: string;
}

function hydrate(r: QaResultRaw): QaTestResult {
  return {
    id: r.id,
    run_id: r.run_id,
    spec_file: r.spec_file,
    test_name: r.test_name,
    status: r.status as QaTestStatus,
    duration_ms: r.duration_ms,
    error: r.error,
    trace_path: r.trace_path,
    screenshot_path: r.screenshot_path,
    video_path: r.video_path,
    summary_md_path: r.summary_md_path ?? null,
    kanban_card_id: r.kanban_card_id ?? null,
    created_at: r.created_at,
  };
}

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;

export class QaTestResultStore implements IQaTestResultStore {
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

  recordResult(input: QaTestResultInsert): number {
    const info = this.db
      .prepare(
        `INSERT INTO qa_test_results
           (run_id, spec_file, test_name, status, duration_ms, error,
            trace_path, screenshot_path, video_path, summary_md_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.run_id,
        input.spec_file,
        input.test_name,
        input.status,
        input.duration_ms,
        input.error,
        input.trace_path,
        input.screenshot_path ?? null,
        input.video_path ?? null,
        input.summary_md_path ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Stamp the auto-created Kanban bug card on a result row. Called by
   * the kanban-bridge after `upsertBugCard` resolves the card id (whether
   * a fresh insert or a reuse of an existing one). Idempotent — passing
   * the same id is a no-op; passing `null` clears the link.
   */
  setKanbanCardId(resultId: number, cardId: number | null): void {
    this.db
      .prepare('UPDATE qa_test_results SET kanban_card_id = ? WHERE id = ?')
      .run(cardId, resultId);
  }

  /**
   * Find the most-recent failure result for a `(run.suite, test_name)`
   * pair across the session — used by the kanban-bridge as the
   * idempotency lookup ("does this test already have an open bug
   * card?"). Returns the most recent matching row (any status), so the
   * bridge can read its `kanban_card_id` and reuse it instead of
   * minting a duplicate card.
   */
  findRecentResultByName(opts: {
    spec_file: string;
    test_name: string;
  }): QaTestResult | null {
    const row = this.db
      .prepare(
        `SELECT * FROM qa_test_results
         WHERE spec_file = ? AND test_name = ? AND kanban_card_id IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(opts.spec_file, opts.test_name) as QaResultRaw | undefined;
    return row ? hydrate(row) : null;
  }

  listResults(runId: number): QaTestResult[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_test_results WHERE run_id = ? ORDER BY id ASC`,
      )
      .all(runId) as QaResultRaw[];
    return rows.map(hydrate);
  }

  listFailures(runId: number): QaTestResult[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_test_results
         WHERE run_id = ? AND status IN ('failed','timed-out','interrupted')
         ORDER BY id ASC`,
      )
      .all(runId) as QaResultRaw[];
    return rows.map(hydrate);
  }

  recentForTest(opts: {
    spec_file: string;
    test_name: string;
    limit?: number;
  }): QaTestResult[] {
    const limit = clampLimit(opts.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM qa_test_results
         WHERE spec_file = ? AND test_name = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(opts.spec_file, opts.test_name, limit) as QaResultRaw[];
    return rows.map(hydrate);
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_RECENT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(MAX_RECENT_LIMIT, Math.floor(raw));
}
