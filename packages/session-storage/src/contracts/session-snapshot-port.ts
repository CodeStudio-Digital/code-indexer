/**
 * Persistence contracts for session-owned file snapshots and review state.
 *
 * Runtime implementations use opaque UUID record IDs and the owning session's
 * filesystem bundle. `Awaitable` keeps the pure service usable with lightweight
 * in-memory test doubles; production callers always use the async filesystem
 * implementation.
 */
export type Awaitable<T> = T | Promise<T>;

export type SessionKind = 'coder' | 'company';
export type BaselineStatus = 'active' | 'closed_kept' | 'closed_reverted';
export type HunkDecision = 'kept' | 'reverted';

export interface BaselineRow<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  id: RecordId;
  /** Ordering is independent of the opaque record identity. */
  seq?: number;
  session_kind: SessionKind;
  session_id: SessionKey;
  project_id: number | null;
  file_path: string;
  content_before: string | null;
  rollback_content: string | null;
  existed_before: number;
  baseline_hash: string;
  oversized: number;
  status: BaselineStatus;
  first_seen_at: string;
  last_edited_at: string;
  closed_at: string | null;
}

export interface EditRow<RecordId extends string = string> {
  id: RecordId;
  seq?: number;
  baseline_id: RecordId;
  turn_number: number | null;
  tool_name: string;
  content_after_hash: string;
  was_delete: number;
  applied_at: string;
}

export interface HunkDecisionRow<RecordId extends string = string> {
  id: RecordId;
  seq?: number;
  baseline_id: RecordId;
  hunk_fingerprint: string;
  decision: HunkDecision;
  decided_at: string;
}

export interface CreateBaselineInput<
  SessionKey extends string = string,
> {
  session_kind: SessionKind;
  session_id: SessionKey;
  project_id?: number | null;
  file_path: string;
  content_before: string | null;
  rollback_content?: string | null;
  existed_before: boolean;
  baseline_hash: string;
  oversized: boolean;
  operation_id?: string;
}

export interface AppendEditInput<
  RecordId extends string = string,
> {
  baseline_id: RecordId;
  turn_number: number | null;
  tool_name: string;
  content_after_hash: string;
  was_delete: boolean;
  operation_id?: string;
}

export interface RoundSnapshotRow<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  id: RecordId;
  seq?: number;
  session_kind: SessionKind;
  session_id: SessionKey;
  /** Canonical numeric message ordering key. */
  round_message_id: number;
  global_baseline_id: RecordId;
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

export interface RecordRoundSnapshotMutationInput<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  session_kind: SessionKind;
  session_id: SessionKey;
  round_message_id: number;
  global_baseline_id: RecordId;
  project_id?: number | null;
  file_path: string;
  content_before: string | null;
  existed_before: boolean;
  content_after: string | null;
  existed_after: boolean;
  oversized: boolean;
  operation_id?: string;
}

export interface RoundHunkDecisionRow<
  RecordId extends string = string,
> {
  id: RecordId;
  seq?: number;
  round_snapshot_id: RecordId;
  hunk_fingerprint: string;
  decision: HunkDecision;
  decided_at: string;
}

export interface RoundReviewFindingRow<
  RecordId extends string = string,
> {
  id: RecordId;
  seq?: number;
  round_snapshot_id: RecordId;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
}

export interface CreateRoundReviewFindingInput<
  RecordId extends string = string,
> {
  round_snapshot_id: RecordId;
  hunk_fingerprint?: string | null;
  old_line?: number | null;
  new_line?: number | null;
  severity?: RoundReviewFindingRow<RecordId>['severity'];
  body: string;
  suggested_fix?: string | null;
  diff_excerpt?: string | null;
  operation_id?: string;
}

export interface SessionSnapshotStorePort<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  /** Exact per-invocation history; older stores may not have captured it. */
  recordToolSnapshotMutation?(input: ToolSnapshotMutation<SessionKey, RecordId>): Awaitable<void>;
  listToolSnapshots?(kind: SessionKind, sessionId: SessionKey, toolUseId: string): Awaitable<ToolSnapshotRow<SessionKey, RecordId>[]>;
  getActiveBaseline(
    kind: SessionKind,
    sessionId: SessionKey,
    filePath: string,
    projectId?: number | null,
  ): Awaitable<BaselineRow<SessionKey, RecordId> | null>;
  getBaselineById(id: RecordId): Awaitable<BaselineRow<SessionKey, RecordId> | null>;
  recordBaselineAndEdit(
    create: CreateBaselineInput<SessionKey>,
    edit: Omit<AppendEditInput<RecordId>, 'baseline_id'>,
  ): Awaitable<{ baseline: BaselineRow<SessionKey, RecordId>; created: boolean }>;
  listBaselines(
    kind: SessionKind,
    sessionId: SessionKey,
    opts?: { includeClosed?: boolean },
  ): Awaitable<BaselineRow<SessionKey, RecordId>[]>;
  listEdits(baselineId: RecordId): Awaitable<EditRow<RecordId>[]>;
  listHunkDecisions(baselineId: RecordId): Awaitable<HunkDecisionRow<RecordId>[]>;
  recordRoundSnapshotMutation(
    input: RecordRoundSnapshotMutationInput<SessionKey, RecordId>,
  ): Awaitable<RoundSnapshotRow<SessionKey, RecordId>>;
  getRoundSnapshotById(id: RecordId): Awaitable<RoundSnapshotRow<SessionKey, RecordId> | null>;
  listRoundSnapshots(
    kind: SessionKind,
    sessionId: SessionKey,
    roundMessageId: number,
    opts?: { includeClosed?: boolean },
  ): Awaitable<RoundSnapshotRow<SessionKey, RecordId>[]>;
  listRoundHunkDecisions(
    roundSnapshotId: RecordId,
  ): Awaitable<RoundHunkDecisionRow<RecordId>[]>;
  upsertRoundHunkDecision(
    roundSnapshotId: RecordId,
    fingerprint: string,
    decision: HunkDecision,
  ): Awaitable<void>;
  closeRoundSnapshot(
    id: RecordId,
    status: Exclude<BaselineStatus, 'active'>,
  ): Awaitable<void>;
  listRoundReviewFindings(
    kind: SessionKind,
    sessionId: SessionKey,
    roundMessageId: number,
  ): Awaitable<RoundReviewFindingRow<RecordId>[]>;
  replaceRoundReviewFindings(
    roundSnapshotIds: RecordId[],
    findings: CreateRoundReviewFindingInput<RecordId>[],
  ): Awaitable<RoundReviewFindingRow<RecordId>[]>;
  upsertHunkDecision(
    baselineId: RecordId,
    fingerprint: string,
    decision: HunkDecision,
  ): Awaitable<void>;
  closeBaseline(
    baselineId: RecordId,
    status: Exclude<BaselineStatus, 'active'>,
  ): Awaitable<void>;
  markBaselineReverted(baselineId: RecordId): Awaitable<void>;
  listActiveBaselineIds(
    kind: SessionKind,
    sessionId: SessionKey,
  ): Awaitable<RecordId[]>;
}

export type ToolSnapshotMutation<SessionKey extends string = string, RecordId extends string = string> =
  Omit<RecordRoundSnapshotMutationInput<SessionKey, RecordId>, 'round_message_id'> & {
    tool_use_id: string;
    round_message_id: number | null;
  };

export type ToolSnapshotRow<SessionKey extends string = string, RecordId extends string = string> =
  ToolSnapshotMutation<SessionKey, RecordId> & { first_seen_at: string; last_edited_at: string };

export type SnapshotReviewSource = 'manual' | 'auto';
export type SnapshotReviewRunStatus = 'running' | 'completed' | 'error';
export type SnapshotReviewCommentStatus = 'open' | 'accepted' | 'dismissed' | 'sent';
export type SnapshotReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | null;
export type SnapshotReviewCommentKind =
  | 'defect'
  | 'missing_change'
  | 'unfulfilled_obligation'
  | 'scope_creep';

export interface SnapshotReviewRun<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  id: RecordId;
  seq?: number;
  session_kind: string;
  session_id: SessionKey;
  source: SnapshotReviewSource;
  status: SnapshotReviewRunStatus;
  provider_id: string | null;
  model_id: string | null;
  raw_response: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SnapshotReviewComment<RecordId extends string = string> {
  id: RecordId;
  seq?: number;
  run_id: RecordId | null;
  baseline_id: RecordId;
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

export interface CreateCommentInput<RecordId extends string = string> {
  run_id?: RecordId | null;
  baseline_id: RecordId;
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
  operation_id?: string;
}

export interface SessionReviewStorePort<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  createRun(input: {
    session_kind: string;
    session_id: SessionKey;
    source: SnapshotReviewSource;
    status?: SnapshotReviewRunStatus;
    operation_id?: string;
  }): Awaitable<SnapshotReviewRun<SessionKey, RecordId>>;
  getRun(id: RecordId): Awaitable<SnapshotReviewRun<SessionKey, RecordId> | null>;
  completeRun(
    id: RecordId,
    patch: {
      status: SnapshotReviewRunStatus;
      provider_id?: string | null;
      model_id?: string | null;
      raw_response?: string | null;
      error?: string | null;
      operation_id?: string;
    },
  ): Awaitable<void>;
  listRuns(
    sessionKind: string,
    sessionId: SessionKey,
  ): Awaitable<SnapshotReviewRun<SessionKey, RecordId>[]>;
  createComment(input: CreateCommentInput<RecordId>): Awaitable<SnapshotReviewComment<RecordId>>;
  getComment(id: RecordId): Awaitable<SnapshotReviewComment<RecordId> | null>;
  listComments(
    sessionKind: string,
    sessionId: SessionKey,
  ): Awaitable<SnapshotReviewComment<RecordId>[]>;
  listCommentsByBaselineIds(
    baselineIds: RecordId[],
  ): Awaitable<SnapshotReviewComment<RecordId>[]>;
  listCommentsByIds(ids: RecordId[]): Awaitable<SnapshotReviewComment<RecordId>[]>;
  updateComment(
    id: RecordId,
    patch: Partial<
      Pick<
        SnapshotReviewComment<RecordId>,
        'status' | 'body' | 'severity' | 'suggested_fix'
      >
    > & { operation_id?: string },
  ): Awaitable<SnapshotReviewComment<RecordId> | null>;
  markSent(ids: RecordId[]): Awaitable<void>;
}
