import { randomUUID } from 'node:crypto';
import {
  asAgentRunId as brandAgentRunId,
  asSessionId as brandSessionId,
  isUuidString,
  type AgentRunId,
  type Brand,
  type SessionId,
} from '@mcp/agent-runtime-contracts/ids.js';

export type CompanySessionId = Brand<string, 'CompanySessionId'>;
export type { AgentRunId, Brand, SessionId };

/** Project registry IDs remain the intentionally numeric SQLite identity. */
export type ProjectId = number;

export function isUuid(value: unknown): value is string {
  return isUuidString(value);
}

function assertUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

export function asSessionId(value: string): SessionId {
  return brandSessionId(assertUuid(value, 'session id'));
}

export function asCompanySessionId(value: string): CompanySessionId {
  return assertUuid(value, 'company session id') as CompanySessionId;
}

export function asAgentRunId(value: string): AgentRunId {
  return brandAgentRunId(assertUuid(value, 'agent run id'));
}

export function newSessionId(): SessionId {
  return brandSessionId(randomUUID());
}

export function newCompanySessionId(): CompanySessionId {
  return randomUUID() as CompanySessionId;
}

export function newAgentRunId(): AgentRunId {
  return brandAgentRunId(randomUUID());
}

export type SessionKind =
  | 'coder'
  | 'company'
  | 'app_studio'
  | 'docs'
  | 'global'
  | (string & {});

export type SessionStorageScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly project_id: ProjectId };

export interface ProjectRootRecord {
  readonly project_id: ProjectId;
  readonly root_path: string;
}

/**
 * Deliberately injected by the host. This package never reads the project
 * registry (SQLite or otherwise).
 */
export interface ProjectRootResolver {
  resolveProjectRoot(projectId: ProjectId): string | null | undefined;
  listProjectRoots(): readonly ProjectRootRecord[];
}

export interface SessionLocation {
  readonly session_id: SessionId;
  readonly scope: SessionStorageScope;
  readonly session_root: string;
  readonly bundle_path: string;
}

export interface SessionProjectLink {
  readonly project_id: ProjectId;
  readonly root_path?: string;
}

export interface SessionMetadata {
  readonly schema_version: 1;
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly created_at: string;
  updated_at: string;
  readonly storage_scope: SessionStorageScope;
  readonly owner_project_id: ProjectId | null;
  readonly linked_projects: readonly SessionProjectLink[];
  readonly parent_session_id: SessionId | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  favorite: boolean;
  archived_at: string | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SessionState {
  readonly schema_version: 1;
  status: string;
  updated_at: string;
  archived_at: string | null;
  goal: JsonValue | null;
  todos: readonly JsonValue[];
  permissions: Readonly<Record<string, JsonValue>>;
  tools: Readonly<Record<string, JsonValue>>;
  compaction: Readonly<Record<string, JsonValue>>;
  cursors: Readonly<Record<string, JsonValue>>;
  readonly extra: Readonly<Record<string, JsonValue>>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ArtifactKind = 'attachment' | 'tool_output_raw' | 'tool_output_shaped' | 'snapshot_blob';

export interface ArtifactRef {
  readonly artifact_id: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly size: number;
  readonly relative_path: string;
  readonly media_type: string | null;
  readonly logical_name: string | null;
}

export interface ConversationCommit {
  readonly schema_version: 1;
  readonly seq: number;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly committed_at: string;
  readonly prev_hash: string | null;
  readonly hash: string;
  readonly payload: JsonValue;
  readonly artifacts: readonly ArtifactRef[];
}

export interface MigrationMarker {
  readonly schema_version: 1;
  readonly source: 'native' | 'legacy_sqlite';
  readonly completed_at: string;
  readonly legacy_id?: number | string;
}

export interface CreateSessionInput {
  readonly id?: SessionId;
  readonly kind: SessionKind;
  readonly scope: SessionStorageScope;
  readonly owner_project_id?: ProjectId | null;
  readonly linked_projects?: readonly SessionProjectLink[];
  readonly parent_session_id?: SessionId | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly title?: string | null;
  readonly favorite?: boolean;
  readonly status?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly state?: Partial<Omit<SessionState, 'schema_version' | 'updated_at'>>;
  readonly migration?: Omit<MigrationMarker, 'schema_version' | 'completed_at'> & {
    readonly completed_at?: string;
  };
}

export interface ArtifactInput {
  readonly kind: ArtifactKind;
  readonly data: Uint8Array | string;
  readonly media_type?: string | null;
  readonly logical_name?: string | null;
}

export interface CommitTurnInput {
  readonly operation_id: string;
  readonly payload: JsonValue;
  readonly artifacts?: readonly ArtifactInput[];
  /**
   * Append-only callers normally refresh session.json after committing. A
   * compound mutation may defer that projection and publish it together with
   * its other state files through updateProjectionBatch.
   */
  readonly touch_session?: boolean;
}

export interface ToolOutputInput {
  readonly call_id: string;
  readonly raw?: Uint8Array | string;
  readonly shaped?: Uint8Array | string;
  /** Shared media type used when a payload-specific type is not supplied. */
  readonly media_type?: string | null;
  readonly raw_media_type?: string | null;
  readonly shaped_media_type?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ToolOutputRecord {
  readonly schema_version: 1;
  readonly id: string;
  readonly call_id: string;
  readonly created_at: string;
  readonly raw: ArtifactRef | null;
  readonly shaped: ArtifactRef | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SessionMetricTokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_creation: number;
}

export interface SessionMetricsSummary {
  readonly schema_version: 1;
  readonly updated_at: string;
  readonly turns: number;
  readonly tool_calls: number;
  readonly provider_attempts: number;
  readonly tokens: SessionMetricTokenTotals;
}

export interface CatalogEntry {
  readonly location: SessionLocation;
  readonly session: SessionMetadata;
  readonly state: SessionState | null;
}

export interface CatalogScanIssue {
  readonly root_path: string;
  readonly code: string;
  readonly message: string;
}

export interface CatalogScanResult {
  readonly entries: readonly CatalogEntry[];
  readonly issues: readonly CatalogScanIssue[];
}

export type SessionRepositoryEvent =
  | { readonly type: 'created' | 'updated' | 'archived' | 'restored'; readonly location: SessionLocation;
      readonly projection?: { readonly session: SessionMetadata; readonly state: SessionState } }
  | { readonly type: 'trashed'; readonly location: SessionLocation; readonly trash_path: string };

export interface SessionStorageFaultContext {
  readonly point: string;
  readonly session_id?: SessionId;
  readonly path?: string;
  readonly operation_id?: string;
}

export type SessionStorageFaultInjector = (
  context: SessionStorageFaultContext,
) => void | Promise<void>;
