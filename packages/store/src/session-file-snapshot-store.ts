/**
 * SessionFileSnapshotStore — persistence layer for migration 079.
 *
 * Three tables:
 *   - session_file_baselines: one active baseline row per (session, file).
 *     Captures the file's content immediately BEFORE the session's first
 *     edit, so the UI can show a cumulative diff (baseline vs current disk)
 *     until the user explicitly accepts or reverts.
 *   - session_file_edits: append-only audit of every mutation routed through
 *     the recording filesystem port. Used to break down a baseline's history
 *     per turn / per tool, never read for diff computation.
 *   - session_file_hunk_decisions: persistent per-hunk verdicts keyed by a
 *     stable content fingerprint. Re-edits to the same region invalidate
 *     the fingerprint and force re-review by design.
 *
 * The store knows nothing about diff/hunk computation — that lives in
 * SessionSnapshotService. All it does is CRUD.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type SessionKind = 'coder' | 'company';
export type BaselineStatus = 'active' | 'closed_kept' | 'closed_reverted';
export type HunkDecision = 'kept' | 'reverted';

export interface BaselineRow {
  id: number;
  session_kind: SessionKind;
  session_id: number;
  /**
   * The project this baseline's file belongs to (migration 154). NULL only for
   * stray legacy/company rows; the diff/revert resolver falls back to the
   * session's primary project in that case.
   */
  project_id: number | null;
  file_path: string;
  content_before: string | null;
  existed_before: number;
  baseline_hash: string;
  oversized: number;
  status: BaselineStatus;
  first_seen_at: string;
  last_edited_at: string;
  closed_at: string | null;
}

export interface EditRow {
  id: number;
  baseline_id: number;
  turn_number: number | null;
  tool_name: string;
  content_after_hash: string;
  was_delete: number;
  applied_at: string;
}

export interface HunkDecisionRow {
  id: number;
  baseline_id: number;
  hunk_fingerprint: string;
  decision: HunkDecision;
  decided_at: string;
}

export interface CreateBaselineInput {
  session_kind: SessionKind;
  session_id: number;
  /** Project the file belongs to (migration 154). Omitted/NULL when unknown —
   *  the resolver then falls back to the session's primary project. */
  project_id?: number | null;
  file_path: string;
  content_before: string | null;
  existed_before: boolean;
  baseline_hash: string;
  oversized: boolean;
}

export interface AppendEditInput {
  baseline_id: number;
  turn_number: number | null;
  tool_name: string;
  content_after_hash: string;
  was_delete: boolean;
}

export class SessionFileSnapshotStore {
  constructor(private readonly db: DB) {}

  /**
   * Return the currently-active baseline for a file, if any. Used to decide
   * whether to create a new baseline or only append to the edit log.
   */
  getActiveBaseline(
    kind: SessionKind,
    sessionId: number,
    filePath: string,
    projectId: number | null = null,
  ): BaselineRow | null {
    // `project_id IS ?` is null-safe equality: with a number it matches that
    // project; with NULL it matches legacy rows. This keeps each root's baseline
    // for the same relative path distinct in a global (multi-project) session.
    const row = this.db
      .prepare(
        `SELECT * FROM session_file_baselines
         WHERE session_kind = ? AND session_id = ? AND file_path = ? AND status = 'active'
           AND project_id IS ?
         LIMIT 1`,
      )
      .get(kind, sessionId, filePath, projectId) as BaselineRow | undefined;
    return row ?? null;
  }

  getBaselineById(id: number): BaselineRow | null {
    const row = this.db
      .prepare('SELECT * FROM session_file_baselines WHERE id = ?')
      .get(id) as BaselineRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically: create a baseline (if none active) AND append an edit row.
   * Returns the resolved baseline (existing or freshly inserted).
   */
  recordBaselineAndEdit(
    create: CreateBaselineInput,
    edit: Omit<AppendEditInput, 'baseline_id'>,
  ): { baseline: BaselineRow; created: boolean } {
    const tx = this.db.transaction(() => {
      let baseline = this.getActiveBaseline(
        create.session_kind,
        create.session_id,
        create.file_path,
        create.project_id ?? null,
      );
      let created = false;
      if (!baseline) {
        const stmt = this.db.prepare(
          `INSERT INTO session_file_baselines
            (session_kind, session_id, project_id, file_path, content_before, existed_before,
             baseline_hash, oversized, status, first_seen_at, last_edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
        );
        const r = stmt.run(
          create.session_kind,
          create.session_id,
          create.project_id ?? null,
          create.file_path,
          create.content_before,
          create.existed_before ? 1 : 0,
          create.baseline_hash,
          create.oversized ? 1 : 0,
        );
        baseline = this.getBaselineById(Number(r.lastInsertRowid))!;
        created = true;
      } else {
        this.db
          .prepare(
            `UPDATE session_file_baselines SET last_edited_at = datetime('now') WHERE id = ?`,
          )
          .run(baseline.id);
      }
      this.db
        .prepare(
          `INSERT INTO session_file_edits
            (baseline_id, turn_number, tool_name, content_after_hash, was_delete, applied_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run(
          baseline.id,
          edit.turn_number,
          edit.tool_name,
          edit.content_after_hash,
          edit.was_delete ? 1 : 0,
        );
      return { baseline, created };
    });
    return tx();
  }

  listBaselines(
    kind: SessionKind,
    sessionId: number,
    opts: { includeClosed?: boolean } = {},
  ): BaselineRow[] {
    if (opts.includeClosed) {
      return this.db
        .prepare(
          `SELECT * FROM session_file_baselines
           WHERE session_kind = ? AND session_id = ?
           ORDER BY first_seen_at ASC`,
        )
        .all(kind, sessionId) as BaselineRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM session_file_baselines
         WHERE session_kind = ? AND session_id = ? AND status = 'active'
         ORDER BY first_seen_at ASC`,
      )
      .all(kind, sessionId) as BaselineRow[];
  }

  listEdits(baselineId: number): EditRow[] {
    return this.db
      .prepare(
        `SELECT * FROM session_file_edits WHERE baseline_id = ? ORDER BY id ASC`,
      )
      .all(baselineId) as EditRow[];
  }

  listHunkDecisions(baselineId: number): HunkDecisionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM session_file_hunk_decisions WHERE baseline_id = ? ORDER BY id ASC`,
      )
      .all(baselineId) as HunkDecisionRow[];
  }

  upsertHunkDecision(
    baselineId: number,
    fingerprint: string,
    decision: HunkDecision,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_file_hunk_decisions
          (baseline_id, hunk_fingerprint, decision, decided_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(baseline_id, hunk_fingerprint) DO UPDATE SET
           decision = excluded.decision,
           decided_at = excluded.decided_at`,
      )
      .run(baselineId, fingerprint, decision);
  }

  /** Marks a baseline closed. Idempotent — no-op if already closed. */
  closeBaseline(baselineId: number, status: 'closed_kept' | 'closed_reverted'): void {
    this.db
      .prepare(
        `UPDATE session_file_baselines
         SET status = ?, closed_at = datetime('now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(status, baselineId);
  }

  /** Returns IDs of all active baselines for a session — used by accept/revert-all. */
  listActiveBaselineIds(kind: SessionKind, sessionId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM session_file_baselines
         WHERE session_kind = ? AND session_id = ? AND status = 'active'`,
      )
      .all(kind, sessionId) as { id: number }[];
    return rows.map((r) => r.id);
  }
}
