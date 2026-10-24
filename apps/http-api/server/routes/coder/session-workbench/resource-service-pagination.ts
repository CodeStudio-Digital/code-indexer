import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { SkillStore, SkillSummaryDefinition } from '@mcp/store/skill-store.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import { type SessionWorkbenchEventPage, type SessionWorkbenchPageInfo, type SessionWorkbenchProcessSummary, type SessionWorkbenchSkillReference } from '@mcp/api-bus';
import { SessionWorkbenchQueryError } from './query-service.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';

interface ResourceCursorPayload {
  version: 1;
  sessionId: string;
  view: string;
  revision: number;
  offset: number;
  sourceCursor: string | null;
}

export type ResourceStore = Pick<
  FsSessionStore,
  | 'getSession'
  | 'getSessionFileMap'
  | 'listConversationChapters'
  | 'listPlans'
  | 'getDriveAggregate'
  | 'listSubagentRuns'
  | 'listTaskRunsPage'
  | 'getMetricsSummary'
  | 'listToolCallSummaries'
  | 'listSessionInputs'
  | 'getSessionDisabledTools'
>;

export type SkillCatalog = Pick<SkillStore, 'listSkillSummaries'>;

export type TimelineReader = (
  sessionId: SessionId,
  query: { cursor?: string; limit: number },
) => Promise<SessionWorkbenchEventPage>;

export const MAX_COALESCED_READS = 64;

export function encodeCursor(payload: ResourceCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
  sessionId: SessionId,
  view: string,
): ResourceCursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ResourceCursorPayload>;
    if (
      parsed.version !== 1 ||
      parsed.sessionId !== sessionId ||
      parsed.view !== view ||
      !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision ?? 0) <= 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.sourceCursor !== null && typeof parsed.sourceCursor !== 'string')
    ) throw new Error('invalid resource cursor');
    return parsed as ResourceCursorPayload;
  } catch {
    throw new SessionWorkbenchQueryError(
      'invalid_cursor',
      400,
      false,
      'resource cursor is malformed or belongs to another session/view',
      { sessionId, view },
    );
  }
}

export function revision(...timestamps: Array<string | null | undefined>): number {
  return Math.max(
    1,
    ...timestamps.map((value) => value == null ? 0 : Date.parse(value)).filter(Number.isFinite),
  );
}

export function assertRevision(
  cursor: ResourceCursorPayload | null,
  current: number,
  sessionId: SessionId,
  view: string,
): void {
  if (cursor && cursor.revision !== current) {
    throw new SessionWorkbenchQueryError(
      'stale_cursor',
      409,
      true,
      'resource changed after this cursor was issued',
      { sessionId, view, expectedRevision: cursor.revision, currentRevision: current },
    );
  }
}

export function arrayPage<T>(
  values: readonly T[],
  cursor: ResourceCursorPayload | null,
  limit: number,
  sessionId: SessionId,
  view: string,
  resourceRevision: number,
): { items: T[]; pageInfo: SessionWorkbenchPageInfo } {
  assertRevision(cursor, resourceRevision, sessionId, view);
  const offset = cursor?.offset ?? 0;
  if (offset > values.length) {
    throw new SessionWorkbenchQueryError(
      'invalid_cursor',
      400,
      false,
      'resource cursor offset is outside the result set',
      { sessionId, view, offset },
    );
  }
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    pageInfo: {
      totalCount: values.length,
      nextCursor: nextOffset < values.length
        ? encodeCursor({
            version: 1,
            sessionId,
            view,
            revision: resourceRevision,
            offset: nextOffset,
            sourceCursor: null,
          })
        : null,
    },
  };
}

export function activeSkillIds(session: FsCoderSession): Set<string> | null {
  const value = session.state.tools.active_skills;
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === 'string'))
    : null;
}

export function skillSource(skill: SkillSummaryDefinition): SessionWorkbenchSkillReference['source'] {
  if (skill.scope !== 'global') return 'workspace';
  if (skill.source === 'builtin') return 'bundled';
  if (skill.source === 'imported') return 'plugin';
  return 'personal';
}

export function scopesFor(
  session: FsCoderSession,
  isCurrentProject: (projectId: number) => boolean,
): string[] {
  const scopes = new Set<string>(['global']);
  for (const project of session.linked_projects) {
    if (isCurrentProject(project.project_id)) scopes.add(String(project.project_id));
  }
  return [...scopes];
}

export function processStatus(status: 'running' | 'completed' | 'failed' | 'aborted'):
SessionWorkbenchProcessSummary['status'] {
  if (status === 'aborted') return 'cancelled';
  return status;
}

export function coalescedKey(kind: string, sessionId: SessionId, query: object): string {
  return `${kind}:${sessionId}:${JSON.stringify(query)}`;
}
