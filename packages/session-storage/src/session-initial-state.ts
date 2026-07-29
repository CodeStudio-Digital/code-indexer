import type {
  CreateSessionInput,
  SessionMetadata,
  SessionState,
} from './types.js';

export function initialSessionMetadata(
  input: CreateSessionInput,
  id: SessionMetadata['id'],
  now: string,
): SessionMetadata {
  return {
    schema_version: 1,
    id,
    kind: input.kind,
    created_at: now,
    updated_at: now,
    storage_scope: input.scope,
    owner_project_id:
      input.owner_project_id ??
      (input.scope.kind === 'project' ? input.scope.project_id : null),
    linked_projects: input.linked_projects ?? [],
    parent_session_id: input.parent_session_id ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    title: input.title ?? null,
    favorite: input.favorite ?? false,
    archived_at: null,
    metadata: input.metadata ?? {},
  };
}

export function initialSessionState(
  input: CreateSessionInput,
  now: string,
): SessionState {
  const supplied = input.state ?? {};
  return {
    schema_version: 1,
    status: supplied.status ?? input.status ?? 'idle',
    updated_at: now,
    archived_at: supplied.archived_at ?? null,
    goal: supplied.goal ?? null,
    todos: supplied.todos ?? [],
    permissions: supplied.permissions ?? {},
    tools: supplied.tools ?? {},
    compaction: supplied.compaction ?? {},
    cursors: supplied.cursors ?? {},
    extra: supplied.extra ?? {},
  };
}
