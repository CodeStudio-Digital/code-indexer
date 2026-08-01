import {
  asSessionId,
  isUuid,
  type ArtifactReader,
  type ArtifactRef,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type {
  BaselineRow,
  BaselineStatus,
  EditRow,
  HunkDecision,
  HunkDecisionRow,
  RoundHunkDecisionRow,
  RoundReviewFindingRow,
  RoundSnapshotRow,
  SessionKind,
  SnapshotReviewCommentKind,
  SnapshotReviewCommentStatus,
  SnapshotReviewRunStatus,
  SnapshotReviewSeverity,
  SnapshotReviewSource,
} from '@mcp/services/services/session-snapshot-port.js';
import type { FsEntityEnvelope } from './entity-files.js';

export interface StoredEdit {
  id: string;
  seq: number;
  turn_number: number | null;
  tool_name: string;
  content_after_hash: string;
  was_delete: boolean;
  applied_at: string;
}

export interface StoredDecision {
  id: string;
  seq: number;
  hunk_fingerprint: string;
  decision: HunkDecision;
  decided_at: string;
}

export interface StoredBaseline {
  session_kind: SessionKind;
  session_id: string;
  project_id: number | null;
  file_path: string;
  content_before: ArtifactRef | null;
  rollback_content: ArtifactRef | null;
  existed_before: boolean;
  baseline_hash: string;
  oversized: boolean;
  status: BaselineStatus;
  first_seen_at: string;
  last_edited_at: string;
  closed_at: string | null;
  edits: StoredEdit[];
  decisions: StoredDecision[];
}

export interface StoredRoundSnapshot {
  session_kind: SessionKind;
  session_id: string;
  round_message_seq: number;
  global_baseline_id: string;
  project_id: number | null;
  file_path: string;
  content_before: ArtifactRef | null;
  existed_before: boolean;
  content_after: ArtifactRef | null;
  existed_after: boolean;
  oversized: boolean;
  status: BaselineStatus;
  first_seen_at: string;
  last_edited_at: string;
  closed_at: string | null;
  decisions: StoredDecision[];
}

export interface StoredRoundReviewFinding {
  id: string;
  seq: number;
  round_snapshot_id: string;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: SnapshotReviewSeverity;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
}

export interface StoredRoundReview {
  session_id: string;
  round_snapshot_ids: string[];
  findings: StoredRoundReviewFinding[];
}

export interface StoredReviewRun {
  session_kind: string;
  session_id: string;
  source: SnapshotReviewSource;
  status: SnapshotReviewRunStatus;
  provider_id: string | null;
  model_id: string | null;
  raw_response: ArtifactRef | null;
  error: string | null;
  completed_at: string | null;
}

export interface StoredReviewComment {
  session_id: string;
  run_id: string | null;
  baseline_id: string;
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
}

export interface StoredIntentContract {
  session_kind: string;
  session_id: string;
  source_hash: string;
  obligations_json: string;
  provider_id: string | null;
  model_id: string | null;
}

export interface StoredReviewFate {
  session_kind: string;
  session_id: string;
  comment_id: string;
  category: string;
  severity: string | null;
  file_path: string;
  outcome: 'accepted' | 'dismissed' | 'reedited' | 'ignored';
  observed_at: string;
}

function object(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} snapshot payload`);
  }
  return value as Record<string, JsonValue>;
}

function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function nullableInteger(
  value: JsonValue | undefined,
  label: string,
): number | null {
  return value === null ? null : integer(value, label);
}

function integer(value: JsonValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return value as number;
}

function artifact(value: JsonValue | undefined, label: string): ArtifactRef | null {
  if (value === null) return null;
  const row = object(value as JsonValue, label);
  if (
    typeof row.artifact_id !== 'string' ||
    typeof row.sha256 !== 'string' ||
    typeof row.relative_path !== 'string' ||
    typeof row.size !== 'number' ||
    row.kind !== 'snapshot_blob'
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return row as unknown as ArtifactRef;
}

function status(value: JsonValue | undefined): BaselineStatus {
  if (value !== 'active' && value !== 'closed_kept' && value !== 'closed_reverted') {
    throw new Error('Invalid snapshot status');
  }
  return value;
}

function decision(value: JsonValue): StoredDecision {
  const row = object(value, 'decision');
  const id = string(row.id, 'decision id');
  if (!isUuid(id)) throw new Error('Invalid decision id');
  const verdict = string(row.decision, 'decision verdict');
  if (verdict !== 'kept' && verdict !== 'reverted') {
    throw new Error('Invalid decision verdict');
  }
  return {
    id,
    seq: integer(row.seq, 'decision seq'),
    hunk_fingerprint: string(row.hunk_fingerprint, 'hunk fingerprint'),
    decision: verdict,
    decided_at: string(row.decided_at, 'decision timestamp'),
  };
}

function edit(value: JsonValue): StoredEdit {
  const row = object(value, 'edit');
  const id = string(row.id, 'edit id');
  if (!isUuid(id)) throw new Error('Invalid edit id');
  return {
    id,
    seq: integer(row.seq, 'edit seq'),
    turn_number: row.turn_number === null ? null : integer(row.turn_number, 'turn number'),
    tool_name: string(row.tool_name, 'edit tool'),
    content_after_hash: string(row.content_after_hash, 'edit hash'),
    was_delete: row.was_delete === true,
    applied_at: string(row.applied_at, 'edit timestamp'),
  };
}

/**
 * Snapshot paths are canonical project-relative POSIX paths. Rejecting
 * traversal here keeps persisted envelopes safe even when imported or
 * recovered independently of the original recorder.
 */
export function validateSnapshotFilePath(value: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:($|\/)/.test(value)
  ) {
    throw new Error('Invalid snapshot file path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('Invalid snapshot file path');
  }
  return value;
}

export function parseBaseline(value: JsonValue): StoredBaseline {
  const row = object(value, 'baseline');
  const sessionId = string(row.session_id, 'baseline session id');
  if (!isUuid(sessionId)) throw new Error('Invalid baseline session id');
  const kind = string(row.session_kind, 'baseline session kind');
  if (kind !== 'coder' && kind !== 'company') throw new Error('Invalid baseline session kind');
  return {
    session_kind: kind,
    session_id: sessionId,
    project_id: row.project_id === null ? null : integer(row.project_id, 'baseline project id'),
    file_path: validateSnapshotFilePath(
      string(row.file_path, 'baseline file path'),
    ),
    content_before: artifact(row.content_before, 'baseline content'),
    rollback_content: artifact(row.rollback_content, 'baseline rollback content'),
    existed_before: row.existed_before === true,
    baseline_hash: string(row.baseline_hash, 'baseline hash'),
    oversized: row.oversized === true,
    status: status(row.status),
    first_seen_at: string(row.first_seen_at, 'baseline created timestamp'),
    last_edited_at: string(row.last_edited_at, 'baseline edit timestamp'),
    closed_at: nullableString(row.closed_at, 'baseline closed timestamp'),
    edits: Array.isArray(row.edits) ? row.edits.map(edit) : [],
    decisions: Array.isArray(row.decisions) ? row.decisions.map(decision) : [],
  };
}

export function parseRound(value: JsonValue): StoredRoundSnapshot {
  const row = object(value, 'round snapshot');
  const sessionId = string(row.session_id, 'round session id');
  const baselineId = string(row.global_baseline_id, 'global baseline id');
  if (!isUuid(sessionId) || !isUuid(baselineId)) throw new Error('Invalid round identity');
  const kind = string(row.session_kind, 'round session kind');
  if (kind !== 'coder' && kind !== 'company') throw new Error('Invalid round session kind');
  return {
    session_kind: kind,
    session_id: sessionId,
    round_message_seq: integer(row.round_message_seq, 'round message seq'),
    global_baseline_id: baselineId,
    project_id: row.project_id === null ? null : integer(row.project_id, 'round project id'),
    file_path: validateSnapshotFilePath(
      string(row.file_path, 'round file path'),
    ),
    content_before: artifact(row.content_before, 'round before content'),
    existed_before: row.existed_before === true,
    content_after: artifact(row.content_after, 'round after content'),
    existed_after: row.existed_after === true,
    oversized: row.oversized === true,
    status: status(row.status),
    first_seen_at: string(row.first_seen_at, 'round created timestamp'),
    last_edited_at: string(row.last_edited_at, 'round edit timestamp'),
    closed_at: nullableString(row.closed_at, 'round closed timestamp'),
    decisions: Array.isArray(row.decisions) ? row.decisions.map(decision) : [],
  };
}

function parseRoundReviewFinding(value: JsonValue): StoredRoundReviewFinding {
  const row = object(value, 'round review finding');
  const id = string(row.id, 'round review finding id');
  const roundSnapshotId = string(
    row.round_snapshot_id,
    'round review snapshot id',
  );
  if (!isUuid(id) || !isUuid(roundSnapshotId)) {
    throw new Error('Invalid round review finding identity');
  }
  const severity = nullableString(
    row.severity,
    'round review finding severity',
  );
  if (
    severity !== null &&
    severity !== 'critical' &&
    severity !== 'high' &&
    severity !== 'medium' &&
    severity !== 'low'
  ) {
    throw new Error('Invalid round review finding severity');
  }
  return {
    id,
    seq: integer(row.seq, 'round review finding seq'),
    round_snapshot_id: roundSnapshotId,
    hunk_fingerprint: nullableString(
      row.hunk_fingerprint,
      'round review hunk fingerprint',
    ),
    old_line: nullableInteger(row.old_line, 'round review old line'),
    new_line: nullableInteger(row.new_line, 'round review new line'),
    severity,
    body: string(row.body, 'round review finding body'),
    suggested_fix: nullableString(
      row.suggested_fix,
      'round review suggested fix',
    ),
    diff_excerpt: nullableString(
      row.diff_excerpt,
      'round review diff excerpt',
    ),
    created_at: string(row.created_at, 'round review finding timestamp'),
  };
}

export function parseRoundReview(value: JsonValue): StoredRoundReview {
  const row = object(value, 'round review');
  const sessionId = string(row.session_id, 'round review session id');
  if (!isUuid(sessionId)) throw new Error('Invalid round review session id');
  if (
    !Array.isArray(row.round_snapshot_ids) ||
    row.round_snapshot_ids.some(
      (id) => typeof id !== 'string' || !isUuid(id),
    )
  ) {
    throw new Error('Invalid round review snapshot ids');
  }
  return {
    session_id: sessionId,
    round_snapshot_ids: [...row.round_snapshot_ids] as string[],
    findings: Array.isArray(row.findings)
      ? row.findings.map(parseRoundReviewFinding)
      : [],
  };
}

async function content(
  store: ArtifactReader,
  ref: ArtifactRef | null,
): Promise<string | null> {
  return ref ? Buffer.from(await store.readAsync(ref)).toString('utf8') : null;
}

export async function baselineRow(
  envelope: FsEntityEnvelope<JsonValue>,
  store: ArtifactReader,
): Promise<BaselineRow<SessionId, string>> {
  const data = parseBaseline(envelope.data);
  const [contentBefore, rollbackContent] = await Promise.all([
    content(store, data.content_before),
    content(store, data.rollback_content),
  ]);
  return {
    id: envelope.id,
    seq: envelope.seq,
    session_kind: data.session_kind,
    session_id: asSessionId(data.session_id),
    project_id: data.project_id,
    file_path: data.file_path,
    content_before: contentBefore,
    rollback_content: rollbackContent,
    existed_before: data.existed_before ? 1 : 0,
    baseline_hash: data.baseline_hash,
    oversized: data.oversized ? 1 : 0,
    status: data.status,
    first_seen_at: data.first_seen_at,
    last_edited_at: data.last_edited_at,
    closed_at: data.closed_at,
  };
}

export async function roundRow(
  envelope: FsEntityEnvelope<JsonValue>,
  store: ArtifactReader,
): Promise<RoundSnapshotRow<SessionId, string>> {
  const data = parseRound(envelope.data);
  const [contentBefore, contentAfter] = await Promise.all([
    content(store, data.content_before),
    content(store, data.content_after),
  ]);
  return {
    id: envelope.id,
    seq: envelope.seq,
    session_kind: data.session_kind,
    session_id: asSessionId(data.session_id),
    round_message_id: data.round_message_seq,
    global_baseline_id: data.global_baseline_id,
    project_id: data.project_id,
    file_path: data.file_path,
    content_before: contentBefore,
    existed_before: data.existed_before ? 1 : 0,
    content_after: contentAfter,
    existed_after: data.existed_after ? 1 : 0,
    oversized: data.oversized ? 1 : 0,
    status: data.status,
    first_seen_at: data.first_seen_at,
    last_edited_at: data.last_edited_at,
    closed_at: data.closed_at,
  };
}

export function editRows(id: string, data: StoredBaseline): EditRow<string>[] {
  return data.edits.map((row) => ({
    ...row,
    baseline_id: id,
    was_delete: row.was_delete ? 1 : 0,
  }));
}

export function decisionRows(
  id: string,
  rows: StoredDecision[],
  round = false,
): HunkDecisionRow<string>[] | RoundHunkDecisionRow<string>[] {
  return rows.map((row) => ({
    ...row,
    ...(round ? { round_snapshot_id: id } : { baseline_id: id }),
  })) as HunkDecisionRow<string>[] | RoundHunkDecisionRow<string>[];
}

export type FsRoundReviewFindingRow = RoundReviewFindingRow<string>;
