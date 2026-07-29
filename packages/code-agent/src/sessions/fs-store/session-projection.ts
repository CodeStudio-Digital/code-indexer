import {
  isUuid,
  type CatalogEntry,
  type FileSessionRepository,
  type JsonValue,
  type ProjectId,
  type SessionLocator,
  type SessionMetadata,
  type SessionState,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import { runtimeFromState } from './advanced-state-codec.js';
import type {
  FsAppendMessageUsage,
  FsCoderSession,
  FsCoderSessionStatus,
  FsLinkedProject,
  FsProjectInfo,
} from './types.js';

export interface CoderUsageProjection {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  last_turn_input_tokens: number;
}

export interface CoderMetadataProjection {
  agent: string | null;
  favorited_at: string | null;
  usage: CoderUsageProjection;
  linked_projects: Array<{
    project_id: ProjectId;
    name?: string;
    root_path?: string;
    is_primary: boolean;
    label: string | null;
  }>;
}

export type FsProjectInfoResolver = (
  projectId: ProjectId,
) => FsProjectInfo | null | undefined;

export const ZERO_USAGE: CoderUsageProjection = {
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_read_tokens: 0,
  total_cache_creation_tokens: 0,
  last_turn_input_tokens: 0,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeStatus(value: unknown): FsCoderSessionStatus {
  if (value === 'running' || value === 'in_progress' || value === 'working') {
    return 'running';
  }
  if (value === 'error') return 'error';
  if (value === 'interrupted') return 'interrupted';
  return 'idle';
}

export function coderMetadata(
  metadata: SessionMetadata['metadata'],
): CoderMetadataProjection {
  const coder = isRecord(metadata.coder) ? metadata.coder : {};
  const usage = isRecord(coder.usage) ? coder.usage : {};
  const linkedProjects = Array.isArray(coder.linked_projects)
    ? coder.linked_projects
        .filter(isRecord)
        .filter((project) => Number.isSafeInteger(project.project_id))
        .map((project) => ({
          project_id: project.project_id as ProjectId,
          ...(typeof project.name === 'string' ? { name: project.name } : {}),
          ...(typeof project.root_path === 'string'
            ? { root_path: project.root_path }
            : {}),
          is_primary: project.is_primary === true,
          label: nullableString(project.label),
        }))
    : [];
  return {
    agent: nullableString(coder.agent),
    favorited_at: nullableString(coder.favorited_at),
    usage: {
      total_input_tokens: finiteNumber(usage.total_input_tokens),
      total_output_tokens: finiteNumber(usage.total_output_tokens),
      total_cache_read_tokens: finiteNumber(usage.total_cache_read_tokens),
      total_cache_creation_tokens: finiteNumber(
        usage.total_cache_creation_tokens,
      ),
      last_turn_input_tokens: finiteNumber(usage.last_turn_input_tokens),
    },
    linked_projects: linkedProjects,
  };
}

export function addUsage(
  current: CoderUsageProjection,
  usage: FsAppendMessageUsage | null | undefined,
): CoderUsageProjection {
  if (!usage) return current;
  return {
    total_input_tokens: current.total_input_tokens + usage.input_tokens,
    total_output_tokens: current.total_output_tokens + usage.output_tokens,
    total_cache_read_tokens:
      current.total_cache_read_tokens +
      (usage.cache_read_input_tokens ?? 0),
    total_cache_creation_tokens:
      current.total_cache_creation_tokens +
      (usage.cache_creation_input_tokens ?? 0),
    last_turn_input_tokens: usage.input_tokens,
  };
}

export function compactionBoundary(state: SessionState): number {
  const boundary = state.compaction.boundary_seq;
  return Number.isSafeInteger(boundary) && (boundary as number) > 0
    ? (boundary as number)
    : 0;
}

export function projectInfo(
  locator: SessionLocator,
  resolver: FsProjectInfoResolver | undefined,
  projectId: ProjectId,
): FsProjectInfo | null {
  const explicit = resolver?.(projectId);
  if (explicit) return explicit;
  // When a catalog resolver was supplied, its null result is authoritative:
  // the project was removed or is otherwise unavailable. Never revive its
  // persisted root through locator/session metadata.
  if (resolver) return null;
  const root = locator
    .listProjectRoots()
    .find((candidate) => candidate.project_id === projectId);
  return root
    ? {
        project_id: projectId,
        name: String(projectId),
        root_path: root.root_path,
      }
    : null;
}

export function linkedProjects(
  entry: CatalogEntry,
  locator: SessionLocator,
  resolver?: FsProjectInfoResolver,
): FsLinkedProject[] {
  const metadata = coderMetadata(entry.session.metadata);
  const details = new Map(
    metadata.linked_projects.map((project) => [
      project.project_id,
      project,
    ]),
  );
  return entry.session.linked_projects.map((link, index) => {
    const persisted = details.get(link.project_id);
    const project = projectInfo(locator, resolver, link.project_id);
    return {
      project_id: link.project_id,
      name: persisted?.name ?? project?.name ?? String(link.project_id),
      // The persisted root is display/history metadata, never filesystem
      // authority. A missing catalog row leaves the global session listable
      // while exposing an explicitly unavailable root.
      root_path: project?.root_path ?? '',
      is_primary:
        persisted?.is_primary ??
        (
          entry.session.owner_project_id === link.project_id ||
          index === 0
        ),
      label: persisted?.label ?? null,
    };
  });
}

function latestTimestamp(
  ...values: Array<string | null | undefined>
): string {
  return (
    values
      .filter((value): value is string => typeof value === 'string')
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
    new Date(0).toISOString()
  );
}

export function mapCatalogEntry(
  entry: CatalogEntry,
  locator: SessionLocator,
  repository: FileSessionRepository,
  resolver?: FsProjectInfoResolver,
): FsCoderSession {
  const state = entry.state ?? repository.readStateSync(entry.location);
  const coder = coderMetadata(entry.session.metadata);
  const metrics = repository.readMetricsSummarySync(entry.location);
  const runtime =
    isRecord(state.extra.runtime) ? state.extra.runtime : {};
  const runtimeState = runtimeFromState(state);
  const permissionMode = state.permissions.mode;
  const externalImport = isRecord(entry.session.metadata.external_import)
    ? entry.session.metadata.external_import
    : {};
  const permissionGrants = Array.isArray(state.permissions.grants)
    ? state.permissions.grants.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const toolProfile = state.tools.profile;
  const boundary = compactionBoundary(state);
  return {
    id: entry.session.id,
    kind: entry.session.kind,
    storage_scope: entry.session.storage_scope,
    project_id: entry.session.owner_project_id,
    is_global: entry.session.storage_scope.kind === 'global',
    linked_projects: linkedProjects(entry, locator, resolver),
    import_source:
      externalImport.source === 'claude-code' ||
      externalImport.source === 'codex'
        ? externalImport.source
        : null,
    import_external_id: nullableString(externalImport.external_id),
    import_fingerprint: nullableString(externalImport.fingerprint),
    import_source_updated_at: nullableString(
      externalImport.source_updated_at,
    ),
    imported_at: nullableString(externalImport.imported_at),
    title: entry.session.title ?? '',
    provider: entry.session.provider ?? '',
    model: entry.session.model ?? '',
    status: normalizeStatus(state.status),
    is_archived: state.archived_at != null,
    archived_at: state.archived_at,
    is_favorite: entry.session.favorite,
    favorited_at: coder.favorited_at,
    group_id:
      typeof runtime.group_id === 'string' && isUuid(runtime.group_id)
        ? runtime.group_id
        : null,
    agent: coder.agent,
    todos_json: state.todos.length > 0 ? JSON.stringify(state.todos) : null,
    worktree_path: runtimeState.worktree_path,
    fallback_provider: runtimeState.fallback_provider,
    fallback_model: runtimeState.fallback_model,
    cloudcode_session_id: runtimeState.cloudcode_session_id,
    last_response_id: runtimeState.last_response_id,
    last_response_message_count: runtimeState.last_response_message_count,
    temperature_override: runtimeState.temperature_override,
    reasoning_effort_override: runtimeState.reasoning_effort_override,
    execution_mode_override: runtimeState.execution_mode_override,
    thinking_enabled: runtimeState.thinking_enabled,
    plan_depth_override: runtimeState.plan_depth_override,
    response_language_override: runtimeState.response_language_override,
    output_style_override: runtimeState.output_style_override,
    preflight_seed_json: runtimeState.preflight_seed_json,
    unrestricted_tool_output: runtimeState.unrestricted_tool_output,
    tool_output_cap_level: runtimeState.tool_output_cap_level,
    tool_permission_mode:
      permissionMode === 'ask' ||
      permissionMode === 'auto' ||
      permissionMode === 'unrestricted'
        ? permissionMode
        : null,
    tool_permission_grants:
      permissionGrants.length > 0 ? JSON.stringify(permissionGrants) : null,
    tool_profile:
      toolProfile === 'bootstrap' ||
      toolProfile === 'navigate' ||
      toolProfile === 'full'
        ? toolProfile
        : null,
    tool_state_json: isRecord(state.tools.toolset)
      ? JSON.stringify(state.tools.toolset)
      : null,
    summary_boundary_id: boundary > 0 ? boundary : null,
    compaction_summary:
      typeof state.compaction.summary === 'string'
        ? state.compaction.summary
        : null,
    total_input_tokens: metrics.tokens.input,
    total_output_tokens: metrics.tokens.output,
    total_cache_read_tokens: metrics.tokens.cache_read,
    total_cache_creation_tokens: metrics.tokens.cache_creation,
    last_turn_input_tokens: coder.usage.last_turn_input_tokens,
    created_at: entry.session.created_at,
    updated_at: latestTimestamp(entry.session.updated_at, state.updated_at),
    metadata: entry.session.metadata,
    state,
  };
}

export function sortedSessions(
  sessions: FsCoderSession[],
): FsCoderSession[] {
  return sessions.sort((left, right) => {
    if (left.is_favorite !== right.is_favorite) {
      return left.is_favorite ? -1 : 1;
    }
    const byTime = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    return byTime || String(left.id).localeCompare(String(right.id));
  });
}

export function initialCoderMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  coder: Partial<CoderMetadataProjection>,
): Readonly<Record<string, JsonValue>> {
  const base = toJsonValue(metadata ?? {}) as Readonly<
    Record<string, JsonValue>
  >;
  const existing = isRecord(base.coder) ? base.coder : {};
  return {
    ...base,
    coder: toJsonValue({
      ...existing,
      agent: coder.agent ?? null,
      favorited_at: null,
      usage: ZERO_USAGE,
      linked_projects: coder.linked_projects ?? [],
    }),
  };
}
