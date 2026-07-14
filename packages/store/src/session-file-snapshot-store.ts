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
  /** Full pre-session content used for rollback even when the visual diff is disabled. */
  rollback_content: string | null;
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
  rollback_content?: string | null;
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

export interface RoundSnapshotRow {
  id: number;
  session_kind: SessionKind;
  session_id: number;
  round_message_id: number;
  global_baseline_id: number;
  project_id: number | null;
  file_path: string;
  content_before: string | null;
  existed_before: number;
  content_after: string | null;
  existed_after: number;
  oversized: number;
  status: BaselineStatus;
  first_seen_at: string;
  last_edited_at: string;
  closed_at: string | null;
}

export interface RecordRoundSnapshotMutationInput {
  session_kind: SessionKind;
  session_id: number;
  round_message_id: number;
  global_baseline_id: number;
  project_id?: number | null;
  file_path: string;
  content_before: string | null;
  existed_before: boolean;
  content_after: string | null;
  existed_after: boolean;
  oversized: boolean;
}

export interface RoundHunkDecisionRow {
  id: number;
  round_snapshot_id: number;
  hunk_fingerprint: string;
  decision: HunkDecision;
  decided_at: string;
}

export interface RoundReviewFindingRow {
  id: number;
  round_snapshot_id: number;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
}

export interface CreateRoundReviewFindingInput {
  round_snapshot_id: number;
  hunk_fingerprint?: string | null;
  old_line?: number | null;
  new_line?: number | null;
  severity?: RoundReviewFindingRow['severity'];
  body: string;
  suggested_fix?: string | null;
  diff_excerpt?: string | null;
}

export class SessionFileSnapshotStore {
  private readonly supportsRollbackContent: boolean;

  constructor(private readonly db: DB) {
    try {
      const columns = db.prepare('PRAGMA table_info(session_file_baselines)').all() as Array<{ name: string }>;
      this.supportsRollbackContent = columns.some((column) => column.name === 'rollback_content');
    } catch {
      this.supportsRollbackContent = false;
    }
  }

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
        const stmt = this.supportsRollbackContent
          ? this.db.prepare(
              `INSERT INTO session_file_baselines
                (session_kind, session_id, project_id, file_path, content_before, rollback_content,
                 existed_before, baseline_hash, oversized, status, first_seen_at, last_edited_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
            )
          : this.db.prepare(
              `INSERT INTO session_file_baselines
                (session_kind, session_id, project_id, file_path, content_before, existed_before,
                 baseline_hash, oversized, status, first_seen_at, last_edited_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
            );
        const values = [
          create.session_kind,
          create.session_id,
          create.project_id ?? null,
          create.file_path,
          create.content_before,
          ...(this.supportsRollbackContent ? [create.rollback_content ?? create.content_before] : []),
          create.existed_before ? 1 : 0,
          create.baseline_hash,
          create.oversized ? 1 : 0,
        ];
        const r = stmt.run(...values);
        baseline = this.getBaselineById(Number(r.lastInsertRowid))!;
        created = true;
      } else {
        this.db
          .prepare(
            `UPDATE session_file_baselines
                SET last_edited_at = datetime('now'),
                    oversized = CASE WHEN oversized = 1 OR ? = 1 THEN 1 ELSE 0 END
              WHERE id = ?`,
          )
          .run(create.oversized ? 1 : 0, baseline.id);
        baseline = this.getBaselineById(baseline.id)!;
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

  /**
   * Upsert the immutable before/after envelope for one user round. The first
   * mutation owns `content_before`; later mutations only advance `content_after`.
   */
  recordRoundSnapshotMutation(input: RecordRoundSnapshotMutationInput): RoundSnapshotRow {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM session_file_round_snapshots
          WHERE session_kind = ? AND session_id = ? AND round_message_id = ?
            AND project_id IS ? AND file_path = ?
          LIMIT 1`,
      ).get(
        input.session_kind,
        input.session_id,
        input.round_message_id,
        input.project_id ?? null,
        input.file_path,
      ) as RoundSnapshotRow | undefined;

      if (existing) {
        this.db.prepare(
          `UPDATE session_file_round_snapshots
              SET content_after = ?, existed_after = ?,
                  oversized = CASE WHEN oversized = 1 OR ? = 1 THEN 1 ELSE 0 END,
                  global_baseline_id = ?, status = 'active', closed_at = NULL,
                  last_edited_at = datetime('now')
            WHERE id = ?`,
        ).run(
          input.content_after,
          input.existed_after ? 1 : 0,
          input.oversized ? 1 : 0,
          input.global_baseline_id,
          existing.id,
        );
        return this.getRoundSnapshotById(existing.id)!;
      }

      const inserted = this.db.prepare(
        `INSERT INTO session_file_round_snapshots
          (session_kind, session_id, round_message_id, global_baseline_id, project_id,
           file_path, content_before, existed_before, content_after, existed_after,
           oversized, status, first_seen_at, last_edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      ).run(
        input.session_kind,
        input.session_id,
        input.round_message_id,
        input.global_baseline_id,
        input.project_id ?? null,
        input.file_path,
        input.content_before,
        input.existed_before ? 1 : 0,
        input.content_after,
        input.existed_after ? 1 : 0,
        input.oversized ? 1 : 0,
      );
      return this.getRoundSnapshotById(Number(inserted.lastInsertRowid))!;
    });
    return tx();
  }

  getRoundSnapshotById(id: number): RoundSnapshotRow | null {
    const row = this.db.prepare(
      'SELECT * FROM session_file_round_snapshots WHERE id = ?',
    ).get(id) as RoundSnapshotRow | undefined;
    return row ?? null;
  }

  listRoundSnapshots(
    kind: SessionKind,
    sessionId: number,
    roundMessageId: number,
    opts: { includeClosed?: boolean } = {},
  ): RoundSnapshotRow[] {
    const statusClause = opts.includeClosed ? '' : " AND status = 'active'";
    return this.db.prepare(
      `SELECT * FROM session_file_round_snapshots
        WHERE session_kind = ? AND session_id = ? AND round_message_id = ?${statusClause}
        ORDER BY first_seen_at ASC, id ASC`,
    ).all(kind, sessionId, roundMessageId) as RoundSnapshotRow[];
  }

  listRoundHunkDecisions(roundSnapshotId: number): RoundHunkDecisionRow[] {
    return this.db.prepare(
      `SELECT * FROM session_file_round_hunk_decisions
        WHERE round_snapshot_id = ? ORDER BY id ASC`,
    ).all(roundSnapshotId) as RoundHunkDecisionRow[];
  }

  upsertRoundHunkDecision(
    roundSnapshotId: number,
    fingerprint: string,
    decision: HunkDecision,
  ): void {
    this.db.prepare(
      `INSERT INTO session_file_round_hunk_decisions
        (round_snapshot_id, hunk_fingerprint, decision, decided_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(round_snapshot_id, hunk_fingerprint) DO UPDATE SET
         decision = excluded.decision,
         decided_at = excluded.decided_at`,
    ).run(roundSnapshotId, fingerprint, decision);
  }

  closeRoundSnapshot(id: number, status: 'closed_kept' | 'closed_reverted'): void {
    this.db.prepare(
      `UPDATE session_file_round_snapshots
          SET status = ?, closed_at = datetime('now')
        WHERE id = ? AND status = 'active'`,
    ).run(status, id);
  }

  listRoundReviewFindings(
    kind: SessionKind,
    sessionId: number,
    roundMessageId: number,
  ): RoundReviewFindingRow[] {
    return this.db.prepare(
      `SELECT f.*
         FROM session_file_round_review_findings f
         JOIN session_file_round_snapshots s ON s.id = f.round_snapshot_id
        WHERE s.session_kind = ? AND s.session_id = ? AND s.round_message_id = ?
        ORDER BY f.id ASC`,
    ).all(kind, sessionId, roundMessageId) as RoundReviewFindingRow[];
  }

  replaceRoundReviewFindings(
    roundSnapshotIds: number[],
    findings: CreateRoundReviewFindingInput[],
  ): RoundReviewFindingRow[] {
    if (roundSnapshotIds.length === 0) return [];
    const placeholders = roundSnapshotIds.map(() => '?').join(',');
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM session_file_round_review_findings
          WHERE round_snapshot_id IN (${placeholders})`,
      ).run(...roundSnapshotIds);
      const insert = this.db.prepare(
        `INSERT INTO session_file_round_review_findings
          (round_snapshot_id, hunk_fingerprint, old_line, new_line, severity,
           body, suggested_fix, diff_excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      );
      const ids: number[] = [];
      for (const finding of findings) {
        const result = insert.run(
          finding.round_snapshot_id,
          finding.hunk_fingerprint ?? null,
          finding.old_line ?? null,
          finding.new_line ?? null,
          finding.severity ?? null,
          finding.body,
          finding.suggested_fix ?? null,
          finding.diff_excerpt ?? null,
        );
        ids.push(Number(result.lastInsertRowid));
      }
      if (ids.length === 0) return [];
      const findingPlaceholders = ids.map(() => '?').join(',');
      return this.db.prepare(
        `SELECT * FROM session_file_round_review_findings
          WHERE id IN (${findingPlaceholders}) ORDER BY id ASC`,
      ).all(...ids) as RoundReviewFindingRow[];
    });
    return tx();
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

  /** A closed-kept global baseline may be reopened from history and restored. */
  markBaselineReverted(baselineId: number): void {
    this.db.prepare(
      `UPDATE session_file_baselines
          SET status = 'closed_reverted', closed_at = datetime('now')
        WHERE id = ?`,
    ).run(baselineId);
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
