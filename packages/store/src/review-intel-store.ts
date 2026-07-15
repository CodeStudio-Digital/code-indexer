/**
 * ReviewIntelStore — persistence for the AI-native review's learning surfaces
 * (migration 224): the compiled intent contract cache and the per-comment
 * fate log that feeds suppression/calibration priors.
 *
 * Kept separate from SessionFileReviewStore on purpose: that store is the
 * comment lifecycle CRUD; this one is the review's MEMORY. Central DB only
 * (both tables are on the project-DB drop list).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type ReviewFateOutcome = 'accepted' | 'dismissed' | 'reedited' | 'ignored';

export interface ReviewFateInput {
  comment_id: number;
  session_kind: string;
  session_id: number;
  /** Finding kind (defect | missing_change | …) — the aggregation bucket. */
  category: string;
  severity: string | null;
  file_path: string;
  outcome: ReviewFateOutcome;
}

export interface ReviewFateAggregate {
  category: string;
  severity: string | null;
  accepted: number;
  dismissed: number;
  reedited: number;
  ignored: number;
  total: number;
}

export interface RecentDismissal {
  body: string;
  file_path: string;
  severity: string | null;
  kind: string;
}

export class ReviewIntelStore {
  constructor(private readonly db: DB) {}

  // ─── Intent-contract cache ─────────────────────────────────────────────

  getContract(sessionKind: string, sessionId: number, sourceHash: string): string | null {
    const row = this.db
      .prepare(
        `SELECT obligations_json FROM session_intent_contracts
          WHERE session_kind = ? AND session_id = ? AND source_hash = ?`,
      )
      .get(sessionKind, sessionId, sourceHash) as { obligations_json: string } | undefined;
    return row?.obligations_json ?? null;
  }

  saveContract(input: {
    session_kind: string;
    session_id: number;
    source_hash: string;
    obligations_json: string;
    provider_id?: string | null;
    model_id?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_intent_contracts
           (session_kind, session_id, source_hash, obligations_json, provider_id, model_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_kind, session_id, source_hash)
         DO UPDATE SET obligations_json = excluded.obligations_json`,
      )
      .run(
        input.session_kind,
        input.session_id,
        input.source_hash,
        input.obligations_json,
        input.provider_id ?? null,
        input.model_id ?? null,
      );
  }

  // ─── Fate tracking ─────────────────────────────────────────────────────

  /** Latest observation wins — a comment's fate can be revised (e.g. an
   *  'ignored' open comment later gets accepted). */
  recordFate(input: ReviewFateInput): void {
    this.db
      .prepare(
        `INSERT INTO review_comment_fates
           (comment_id, session_kind, session_id, category, severity, file_path, outcome, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(comment_id)
         DO UPDATE SET outcome = excluded.outcome, observed_at = excluded.observed_at`,
      )
      .run(
        input.comment_id,
        input.session_kind,
        input.session_id,
        input.category,
        input.severity,
        input.file_path,
        input.outcome,
      );
  }

  /** Aggregate per (category × severity). With `projectId`, only fates of
   *  that project's coder sessions count — priors are per-REPO calibration,
   *  not cross-project leakage. Without it, the legacy global aggregate. */
  aggregateFates(projectId?: number): ReviewFateAggregate[] {
    const scope =
      projectId != null
        ? `WHERE session_kind = 'coder'
             AND session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`
        : '';
    const stmt = this.db.prepare(
      `SELECT category, severity,
              SUM(CASE WHEN outcome = 'accepted'  THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN outcome = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
              SUM(CASE WHEN outcome = 'reedited'  THEN 1 ELSE 0 END) AS reedited,
              SUM(CASE WHEN outcome = 'ignored'   THEN 1 ELSE 0 END) AS ignored,
              COUNT(*) AS total
         FROM review_comment_fates
         ${scope}
        GROUP BY category, severity`,
    );
    return (projectId != null ? stmt.all(projectId) : stmt.all()) as ReviewFateAggregate[];
  }

  /** Most recent explicit dismissals — the few-shot negatives for the prompt.
   *  Scoped to one project when `projectId` is given (dismissal bodies from
   *  other projects must not leak into this repo's prompt). */
  recentDismissals(limit = 3, projectId?: number): RecentDismissal[] {
    if (projectId == null) {
      return this.db
        .prepare(
          `SELECT body, file_path, severity, kind
             FROM session_file_review_comments
            WHERE status = 'dismissed'
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(limit) as RecentDismissal[];
    }
    return this.db
      .prepare(
        `SELECT c.body, c.file_path, c.severity, c.kind
           FROM session_file_review_comments c
           JOIN session_file_baselines b ON b.id = c.baseline_id
           JOIN coder_sessions s ON s.id = b.session_id AND b.session_kind = 'coder'
          WHERE c.status = 'dismissed' AND s.project_id = ?
          ORDER BY c.updated_at DESC
          LIMIT ?`,
      )
      .all(projectId, limit) as RecentDismissal[];
  }
}
