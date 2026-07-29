import {
  asSessionId,
  isUuid,
  type ArtifactReader,
  type ArtifactRef,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type {
  SnapshotReviewComment,
  SnapshotReviewCommentKind,
  SnapshotReviewCommentStatus,
  SnapshotReviewRun,
  SnapshotReviewRunStatus,
  SnapshotReviewSeverity,
  SnapshotReviewSource,
} from '@mcp/services/services/session-snapshot-port.js';
import type { FsEntityEnvelope } from './entity-files.js';
import type {
  StoredIntentContract,
  StoredReviewComment,
  StoredReviewFate,
  StoredReviewRun,
} from './snapshot-files-codec.js';
import { validateSnapshotFilePath } from './snapshot-files-codec.js';

function object(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} payload`);
  }
  return value as Record<string, JsonValue>;
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function nullable(value: JsonValue | undefined, label: string): string | null {
  return value === null ? null : text(value, label);
}

function uuid(value: JsonValue | undefined, label: string): string {
  const result = text(value, label);
  if (!isUuid(result)) throw new Error(`Invalid ${label}`);
  return result;
}

function source(value: JsonValue | undefined): SnapshotReviewSource {
  if (value !== 'manual' && value !== 'auto') throw new Error('Invalid review source');
  return value;
}

function runStatus(value: JsonValue | undefined): SnapshotReviewRunStatus {
  if (value !== 'running' && value !== 'completed' && value !== 'error') {
    throw new Error('Invalid review run status');
  }
  return value;
}

function commentStatus(value: JsonValue | undefined): SnapshotReviewCommentStatus {
  if (
    value !== 'open' &&
    value !== 'accepted' &&
    value !== 'dismissed' &&
    value !== 'sent'
  ) {
    throw new Error('Invalid review comment status');
  }
  return value;
}

function severity(value: JsonValue | undefined): SnapshotReviewSeverity {
  if (
    value !== null &&
    value !== 'critical' &&
    value !== 'high' &&
    value !== 'medium' &&
    value !== 'low'
  ) {
    throw new Error('Invalid review severity');
  }
  return value;
}

function kind(value: JsonValue | undefined): SnapshotReviewCommentKind {
  if (
    value !== 'defect' &&
    value !== 'missing_change' &&
    value !== 'unfulfilled_obligation' &&
    value !== 'scope_creep'
  ) {
    throw new Error('Invalid review comment kind');
  }
  return value;
}

function artifact(value: JsonValue | undefined): ArtifactRef | null {
  if (value === null) return null;
  const row = object(value as JsonValue, 'review raw response');
  if (
    row.kind !== 'snapshot_blob' ||
    typeof row.sha256 !== 'string' ||
    typeof row.relative_path !== 'string' ||
    typeof row.size !== 'number'
  ) {
    throw new Error('Invalid review raw response artifact');
  }
  return row as unknown as ArtifactRef;
}

export function parseReviewRun(value: JsonValue): StoredReviewRun {
  const row = object(value, 'review run');
  return {
    session_kind: text(row.session_kind, 'review session kind'),
    session_id: uuid(row.session_id, 'review session id'),
    source: source(row.source),
    status: runStatus(row.status),
    provider_id: nullable(row.provider_id, 'review provider id'),
    model_id: nullable(row.model_id, 'review model id'),
    raw_response: artifact(row.raw_response),
    error: nullable(row.error, 'review error'),
    completed_at: nullable(row.completed_at, 'review completion timestamp'),
  };
}

export function parseReviewComment(value: JsonValue): StoredReviewComment {
  const row = object(value, 'review comment');
  const runId = row.run_id === null ? null : uuid(row.run_id, 'review run id');
  const numberOrNull = (input: JsonValue | undefined, label: string) => {
    if (input === null) return null;
    if (!Number.isSafeInteger(input)) throw new Error(`Invalid ${label}`);
    return input as number;
  };
  return {
    session_id: uuid(row.session_id, 'review comment session id'),
    run_id: runId,
    baseline_id: uuid(row.baseline_id, 'review baseline id'),
    source: source(row.source),
    status: commentStatus(row.status),
    file_path: validateSnapshotFilePath(
      text(row.file_path, 'review file path'),
    ),
    hunk_fingerprint: nullable(row.hunk_fingerprint, 'review hunk fingerprint'),
    old_line: numberOrNull(row.old_line, 'review old line'),
    new_line: numberOrNull(row.new_line, 'review new line'),
    severity: severity(row.severity),
    kind: kind(row.kind),
    obligation_id: nullable(row.obligation_id, 'review obligation id'),
    symbol_anchor: nullable(row.symbol_anchor, 'review symbol anchor'),
    body: text(row.body, 'review body'),
    suggested_fix: nullable(row.suggested_fix, 'review suggested fix'),
    diff_excerpt: nullable(row.diff_excerpt, 'review diff excerpt'),
  };
}

export function parseIntentContract(value: JsonValue): StoredIntentContract {
  const row = object(value, 'intent contract');
  return {
    session_kind: text(row.session_kind, 'intent session kind'),
    session_id: uuid(row.session_id, 'intent session id'),
    source_hash: text(row.source_hash, 'intent source hash'),
    obligations_json: text(row.obligations_json, 'intent obligations'),
    provider_id: nullable(row.provider_id, 'intent provider id'),
    model_id: nullable(row.model_id, 'intent model id'),
  };
}

export function parseReviewFate(value: JsonValue): StoredReviewFate {
  const row = object(value, 'review fate');
  const outcome = text(row.outcome, 'review fate outcome');
  if (
    outcome !== 'accepted' &&
    outcome !== 'dismissed' &&
    outcome !== 'reedited' &&
    outcome !== 'ignored'
  ) {
    throw new Error('Invalid review fate outcome');
  }
  return {
    session_kind: text(row.session_kind, 'review fate session kind'),
    session_id: uuid(row.session_id, 'review fate session id'),
    comment_id: uuid(row.comment_id, 'review fate comment id'),
    category: text(row.category, 'review fate category'),
    severity: nullable(row.severity, 'review fate severity'),
    file_path: validateSnapshotFilePath(
      text(row.file_path, 'review fate file path'),
    ),
    outcome,
    observed_at: text(row.observed_at, 'review fate timestamp'),
  };
}

export function hydrateReviewRun(
  envelope: FsEntityEnvelope<JsonValue>,
  store: ArtifactReader,
): SnapshotReviewRun<SessionId, string> {
  const data = parseReviewRun(envelope.data);
  return {
    id: envelope.id,
    seq: envelope.seq,
    session_kind: data.session_kind,
    session_id: asSessionId(data.session_id),
    source: data.source,
    status: data.status,
    provider_id: data.provider_id,
    model_id: data.model_id,
    raw_response: data.raw_response
      ? Buffer.from(store.read(data.raw_response)).toString('utf8')
      : null,
    error: data.error,
    created_at: envelope.created_at,
    completed_at: data.completed_at,
  };
}

export function hydrateReviewComment(
  envelope: FsEntityEnvelope<JsonValue>,
): SnapshotReviewComment<string> {
  const data = parseReviewComment(envelope.data);
  return {
    id: envelope.id,
    seq: envelope.seq,
    run_id: data.run_id,
    baseline_id: data.baseline_id,
    source: data.source,
    status: data.status,
    file_path: data.file_path,
    hunk_fingerprint: data.hunk_fingerprint,
    old_line: data.old_line,
    new_line: data.new_line,
    severity: data.severity,
    kind: data.kind,
    obligation_id: data.obligation_id,
    symbol_anchor: data.symbol_anchor,
    body: data.body,
    suggested_fix: data.suggested_fix,
    diff_excerpt: data.diff_excerpt,
    created_at: envelope.created_at,
    updated_at: envelope.updated_at,
  };
}
