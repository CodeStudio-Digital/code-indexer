/**
 * Persistence for review feedback attached to session file snapshots.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type SnapshotReviewSource = 'manual' | 'auto';
export type SnapshotReviewRunStatus = 'running' | 'completed' | 'error';
export type SnapshotReviewCommentStatus = 'open' | 'accepted' | 'dismissed' | 'sent';
export type SnapshotReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | null;
/** Unified finding kind (migration 224). 'defect' for pre-224 rows. */
export type SnapshotReviewCommentKind =
  | 'defect'
  | 'missing_change'
  | 'unfulfilled_obligation'
  | 'scope_creep';

export interface SnapshotReviewRun {
  id: number;
  session_kind: string;
  session_id: number;
  source: SnapshotReviewSource;
  status: SnapshotReviewRunStatus;
  provider_id: string | null;
  model_id: string | null;
  raw_response: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SnapshotReviewComment {
  id: number;
  run_id: number | null;
  baseline_id: number;
  source: SnapshotReviewSource;
  status: SnapshotReviewCommentStatus;
  file_path: string;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: SnapshotReviewSeverity;
  kind: SnapshotReviewCommentKind;
  obligation_id: string | null;
  symbol_anchor: string | null;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCommentInput {
  run_id?: number | null;
  baseline_id: number;
  source: SnapshotReviewSource;
  status?: SnapshotReviewCommentStatus;
  file_path: string;
  hunk_fingerprint?: string | null;
  old_line?: number | null;
  new_line?: number | null;
  severity?: SnapshotReviewSeverity;
  kind?: SnapshotReviewCommentKind;
  obligation_id?: string | null;
  symbol_anchor?: string | null;
  body: string;
  suggested_fix?: string | null;
  diff_excerpt?: string | null;
}

export class SessionFileReviewStore {
  constructor(private readonly db: DB) {}

  createRun(input: {
    session_kind: string;
    session_id: number;
    source: SnapshotReviewSource;
    status?: SnapshotReviewRunStatus;
  }): SnapshotReviewRun {
    const r = this.db
      .prepare(
        `INSERT INTO session_file_review_runs
          (session_kind, session_id, source, status)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.session_kind, input.session_id, input.source, input.status ?? 'running');
    return this.getRun(Number(r.lastInsertRowid))!;
  }

  getRun(id: number): SnapshotReviewRun | null {
    const row = this.db
      .prepare('SELECT * FROM session_file_review_runs WHERE id = ?')
      .get(id) as SnapshotReviewRun | undefined;
    return row ?? null;
  }

  completeRun(
    id: number,
    patch: {
      status: SnapshotReviewRunStatus;
      provider_id?: string | null;
      model_id?: string | null;
      raw_response?: string | null;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE session_file_review_runs
            SET status = @status,
                provider_id = @provider_id,
                model_id = @model_id,
                raw_response = @raw_response,
                error = @error,
                completed_at = datetime('now')
          WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status,
        provider_id: patch.provider_id ?? null,
        model_id: patch.model_id ?? null,
        raw_response: patch.raw_response ?? null,
        error: patch.error ?? null,
      });
  }

  listRuns(sessionKind: string, sessionId: number): SnapshotReviewRun[] {
    return this.db
      .prepare(
        `SELECT * FROM session_file_review_runs
         WHERE session_kind = ? AND session_id = ?
         ORDER BY id DESC`,
      )
      .all(sessionKind, sessionId) as SnapshotReviewRun[];
  }

  createComment(input: CreateCommentInput): SnapshotReviewComment {
    const r = this.db
      .prepare(
        `INSERT INTO session_file_review_comments
          (run_id, baseline_id, source, status, file_path, hunk_fingerprint,
           old_line, new_line, severity, kind, obligation_id, symbol_anchor,
           body, suggested_fix, diff_excerpt)
         VALUES
          (@run_id, @baseline_id, @source, @status, @file_path, @hunk_fingerprint,
           @old_line, @new_line, @severity, @kind, @obligation_id, @symbol_anchor,
           @body, @suggested_fix, @diff_excerpt)`,
      )
      .run({
        run_id: input.run_id ?? null,
        baseline_id: input.baseline_id,
        source: input.source,
        status: input.status ?? 'open',
        file_path: input.file_path,
        hunk_fingerprint: input.hunk_fingerprint ?? null,
        old_line: input.old_line ?? null,
        new_line: input.new_line ?? null,
        severity: input.severity ?? null,
        kind: input.kind ?? 'defect',
        obligation_id: input.obligation_id ?? null,
        symbol_anchor: input.symbol_anchor ?? null,
        body: input.body,
        suggested_fix: input.suggested_fix ?? null,
        diff_excerpt: input.diff_excerpt ?? null,
      });
    return this.getComment(Number(r.lastInsertRowid))!;
  }

  getComment(id: number): SnapshotReviewComment | null {
    const row = this.db
      .prepare('SELECT * FROM session_file_review_comments WHERE id = ?')
      .get(id) as SnapshotReviewComment | undefined;
    return row ?? null;
  }

  listComments(sessionKind: string, sessionId: number): SnapshotReviewComment[] {
    return this.db
      .prepare(
        `SELECT c.*
           FROM session_file_review_comments c
           JOIN session_file_baselines b ON b.id = c.baseline_id
          WHERE b.session_kind = ? AND b.session_id = ?
          ORDER BY c.id ASC`,
      )
      .all(sessionKind, sessionId) as SnapshotReviewComment[];
  }

  listCommentsByBaselineIds(baselineIds: number[]): SnapshotReviewComment[] {
    if (baselineIds.length === 0) return [];
    const placeholders = baselineIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM session_file_review_comments
         WHERE baseline_id IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(...baselineIds) as SnapshotReviewComment[];
  }

  listCommentsByIds(ids: number[]): SnapshotReviewComment[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM session_file_review_comments WHERE id IN (${placeholders})`)
      .all(...ids) as SnapshotReviewComment[];
  }

  updateComment(
    id: number,
    patch: Partial<Pick<SnapshotReviewComment, 'status' | 'body' | 'severity' | 'suggested_fix'>>,
  ): SnapshotReviewComment | null {
    const current = this.getComment(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE session_file_review_comments
            SET status = @status,
                body = @body,
                severity = @severity,
                suggested_fix = @suggested_fix,
                updated_at = datetime('now')
          WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status ?? current.status,
        body: patch.body ?? current.body,
        severity: patch.severity ?? current.severity,
        suggested_fix: patch.suggested_fix ?? current.suggested_fix,
      });
    return this.getComment(id);
  }

  markSent(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE session_file_review_comments
            SET status = 'sent', updated_at = datetime('now')
          WHERE id IN (${placeholders})`,
      )
      .run(...ids);
  }
}
