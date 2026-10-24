import {
  type SessionWorkbenchConfigurationQuery,
  type SessionWorkbenchConfigurationResource,
  type SessionWorkbenchContextQuery,
  type SessionWorkbenchContextResource,
  type SessionWorkbenchExecutionQuery,
  type SessionWorkbenchExecutionResource,
  type SessionWorkbenchEventPage,
  type SessionWorkbenchInsightsMetric,
  type SessionWorkbenchInsightsQuery,
  type SessionWorkbenchInsightsResource,
  type SessionWorkbenchPageInfo,
  type SessionWorkbenchProcessSummary,
  type SessionWorkbenchSkillReference,
} from '@mcp/api-bus';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import type { ToolMeta } from '@mcp/code-agent/tools/tiers.js';
import type {
  SkillStore,
  SkillSummaryDefinition,
} from '@mcp/store/skill-store.js';
import {
  SessionWorkbenchQueryError,
  type SessionWorkbenchRuntimeStateResolver,
} from './query-service.js';

interface ResourceCursorPayload {
  version: 1;
  sessionId: string;
  view: string;
  revision: number;
  offset: number;
  sourceCursor: string | null;
}

type ResourceStore = Pick<
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

type SkillCatalog = Pick<SkillStore, 'listSkillSummaries'>;

type TimelineReader = (
  sessionId: SessionId,
  query: { cursor?: string; limit: number },
) => Promise<SessionWorkbenchEventPage>;

const MAX_COALESCED_READS = 64;

function encodeCursor(payload: ResourceCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(
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

function revision(...timestamps: Array<string | null | undefined>): number {
  return Math.max(
    1,
    ...timestamps.map((value) => value == null ? 0 : Date.parse(value)).filter(Number.isFinite),
  );
}

function assertRevision(
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

function arrayPage<T>(
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

function activeSkillIds(session: FsCoderSession): Set<string> | null {
  const value = session.state.tools.active_skills;
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === 'string'))
    : null;
}

function skillSource(skill: SkillSummaryDefinition): SessionWorkbenchSkillReference['source'] {
  if (skill.scope !== 'global') return 'workspace';
  if (skill.source === 'builtin') return 'bundled';
  if (skill.source === 'imported') return 'plugin';
  return 'personal';
}

function scopesFor(
  session: FsCoderSession,
  isCurrentProject: (projectId: number) => boolean,
): string[] {
  const scopes = new Set<string>(['global']);
  for (const project of session.linked_projects) {
    if (isCurrentProject(project.project_id)) scopes.add(String(project.project_id));
  }
  return [...scopes];
}

function processStatus(status: 'running' | 'completed' | 'failed' | 'aborted'):
SessionWorkbenchProcessSummary['status'] {
  if (status === 'aborted') return 'cancelled';
  return status;
}

function coalescedKey(kind: string, sessionId: SessionId, query: object): string {
  return `${kind}:${sessionId}:${JSON.stringify(query)}`;
}

export class SessionWorkbenchResourceService {
  private readonly coalesced = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ResourceStore,
    private readonly skillCatalog: SkillCatalog,
    private readonly listTools: () => ToolMeta[],
    private readonly isCurrentProject: (projectId: number) => boolean,
    private readonly resolveRuntimeState: SessionWorkbenchRuntimeStateResolver,
    private readonly listTimeline?: TimelineReader,
  ) {}

  context(sessionId: SessionId, query: SessionWorkbenchContextQuery): Promise<SessionWorkbenchContextResource> {
    return this.coalesce(coalescedKey('context', sessionId, query), async () => {
      const session = await this.requireSession(sessionId);
      const cursor = decodeCursor(query.cursor, sessionId, query.view);
      if (query.view === 'files') {
        const map = await this.store.getSessionFileMap(sessionId);
        const changed = new Set(map.changed);
        const values = [
          ...map.changed.map((path) => ({ path, kind: 'active' as const })),
          ...map.read.filter((path) => !changed.has(path)).map((path) => ({ path, kind: 'referenced' as const })),
        ].sort((left, right) => left.path.localeCompare(right.path));
        const resourceRevision = revision(session.updated_at);
        const page = arrayPage(values, cursor, query.limit, sessionId, query.view, resourceRevision);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'files',
          files: page.items.map(({ path, kind }) => ({
            id: `file:${path}`,
            displayPath: path,
            kind,
            startLine: null,
            endLine: null,
          })),
          pageInfo: page.pageInfo,
        };
      }
      if (query.view === 'skills') {
        const explicit = activeSkillIds(session);
        const page = this.skillCatalog.listSkillSummaries({
          scopes: scopesFor(session, this.isCurrentProject),
          offset: cursor?.offset ?? 0,
          limit: query.limit,
          ...(explicit == null ? { enabled: true } : { ids: [...explicit] }),
        });
        const resourceRevision = Math.max(revision(session.updated_at), page.revision);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'skills',
          skills: page.items.map((skill) => ({
            id: skill.id,
            name: skill.name,
            source: skillSource(skill),
            active: explicit?.has(skill.id) ?? skill.enabled,
          })),
          pageInfo: {
            totalCount: page.totalCount,
            nextCursor: page.nextOffset == null ? null : encodeCursor({
              version: 1,
              sessionId,
              view: query.view,
              revision: resourceRevision,
              offset: page.nextOffset,
              sourceCursor: null,
            }),
          },
        };
      }
      if (query.view === 'chapters') {
        const page = await this.store.listConversationChapters(sessionId, {
          limit: query.limit,
          cursor: cursor?.sourceCursor ?? null,
        });
        const resourceRevision = Math.max(revision(session.updated_at), page.revision ?? 1);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'chapters',
          chapters: page.items.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            status: chapter.chapter_kind,
            updatedAt: chapter.created_at,
          })),
          pageInfo: {
            totalCount: page.total_count ?? page.items.length,
            nextCursor: page.next_cursor == null ? null : encodeCursor({
              version: 1,
              sessionId,
              view: query.view,
              revision: resourceRevision,
              offset: (cursor?.offset ?? 0) + page.items.length,
              sourceCursor: page.next_cursor,
            }),
          },
        };
      }
      if (query.view === 'plans') {
        const plans = await this.store.listPlans(sessionId);
        const resourceRevision = Math.max(
          revision(session.updated_at),
          ...plans.map((plan) => revision(plan.created_at, plan.resolved_at)),
        );
        const page = arrayPage(plans, cursor, query.limit, sessionId, query.view, resourceRevision);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'plans',
          plans: page.items.map((plan) => ({
            id: plan.id,
            title: plan.plan_text.split(/\r?\n/, 1)[0].trim().slice(0, 160) || plan.id,
            status: plan.status,
            updatedAt: plan.resolved_at ?? plan.created_at,
          })),
          pageInfo: page.pageInfo,
        };
      }

      const drive = await this.store.getDriveAggregate(sessionId);
      const updatedAt = [
        ...drive.memory.map((item) => item.updated_at),
        ...drive.investigations.map((item) => item.created_at),
        ...drive.plans.map((item) => item.resolved_at ?? item.created_at),
        session.updated_at,
      ].sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
      const entryCount = drive.memory.length + drive.investigations.length + drive.plans.length +
        drive.fileMap.read.length + drive.fileMap.changed.length + (drive.tasks?.tasks.length ?? 0);
      const resourceRevision = revision(updatedAt);
      assertRevision(cursor, resourceRevision, sessionId, query.view);
      return {
        sessionId,
        revision: resourceRevision,
        view: 'drive',
        drive: { available: true, entryCount, lastUpdatedAt: updatedAt },
        pageInfo: { totalCount: entryCount, nextCursor: null },
      };
    });
  }

  execution(sessionId: SessionId, query: SessionWorkbenchExecutionQuery): Promise<SessionWorkbenchExecutionResource> {
    return this.coalesce(coalescedKey('execution', sessionId, query), async () => {
      const session = await this.requireSession(sessionId);
      const runtime = await this.resolveRuntimeState(sessionId);
      const run = {
        active: runtime.active,
        waitingForInput: runtime.waitingForInput,
        startedAt: null,
        lastEventAt: session.updated_at,
      };
      if (query.view === 'timeline' && this.listTimeline) {
        const page = await this.listTimeline(sessionId, {
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        });
        return {
          sessionId,
          revision: page.revision,
          view: 'timeline',
          run,
          entries: {
            availability: 'available',
            items: page.events
              .filter((event) => event.type === 'execution.event')
              .map((event) => event.data),
          },
          pageInfo: { totalCount: page.totalCount, nextCursor: page.nextCursor },
        };
      }
      const cursor = decodeCursor(query.cursor, sessionId, query.view);
      if (query.view === 'timeline') {
        const resourceRevision = revision(session.updated_at);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'timeline',
          run,
          entries: { availability: 'pending', reason: 'event_projection_pending' },
          pageInfo: { totalCount: 0, nextCursor: null },
        };
      }
      if (query.view === 'subagents') {
        const page = await this.store.listSubagentRuns(sessionId, cursor?.offset ?? 0, query.limit);
        const resourceRevision = Math.max(revision(session.updated_at), page.revision);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'subagents',
          run,
          subagents: page.items.map((item) => ({
            id: item.run_id,
            label: item.label ?? item.profile,
            status: item.status === 'interrupted' ? 'cancelled' : item.status,
            startedAt: item.started_at,
            finishedAt: item.completed_at,
          })),
          pageInfo: {
            totalCount: page.totalCount,
            nextCursor: page.nextOffset == null ? null : encodeCursor({
              version: 1,
              sessionId,
              view: query.view,
              revision: resourceRevision,
              offset: page.nextOffset,
              sourceCursor: null,
            }),
          },
        };
      }

      const page = await this.store.listTaskRunsPage(sessionId, cursor?.offset ?? 0, query.limit);
      const resourceRevision = Math.max(revision(session.updated_at), page.revision);
      assertRevision(cursor, resourceRevision, sessionId, query.view);
      return {
        sessionId,
        revision: resourceRevision,
        view: 'processes',
        run,
        processes: page.items.map((item) => ({
          id: item.run_id,
          labelKey: item.mode === 'auto'
            ? 'execution.process.automatic'
            : 'execution.process.inlineAll',
          status: processStatus(item.status),
          startedAt: item.started_at,
        })),
        pageInfo: {
          totalCount: page.totalCount,
          nextCursor: page.nextOffset == null ? null : encodeCursor({
            version: 1,
            sessionId,
            view: query.view,
            revision: resourceRevision,
            offset: page.nextOffset,
            sourceCursor: null,
          }),
        },
      };
    });
  }

  insights(sessionId: SessionId, query: SessionWorkbenchInsightsQuery): Promise<SessionWorkbenchInsightsResource> {
    return this.coalesce(coalescedKey('insights', sessionId, query), async () => {
      const session = await this.requireSession(sessionId);
      const cursor = decodeCursor(query.cursor, sessionId, query.view);
      if (query.view === 'overview' || query.view === 'usage') {
        const metrics = await this.store.getMetricsSummary(sessionId);
        const values: SessionWorkbenchInsightsMetric[] = query.view === 'overview'
          ? [
              { id: 'turns', labelKey: 'insights.metrics.turns', value: metrics.turns, unit: 'count' },
              { id: 'tool_calls', labelKey: 'insights.metrics.toolCalls', value: metrics.tool_calls, unit: 'count' },
              { id: 'provider_attempts', labelKey: 'insights.metrics.providerAttempts', value: metrics.provider_attempts, unit: 'count' },
            ]
          : [
              { id: 'input_tokens', labelKey: 'insights.metrics.inputTokens', value: metrics.tokens.input, unit: 'tokens' },
              { id: 'output_tokens', labelKey: 'insights.metrics.outputTokens', value: metrics.tokens.output, unit: 'tokens' },
              { id: 'cache_read_tokens', labelKey: 'insights.metrics.cacheReadTokens', value: metrics.tokens.cache_read, unit: 'tokens' },
              { id: 'cache_creation_tokens', labelKey: 'insights.metrics.cacheCreationTokens', value: metrics.tokens.cache_creation, unit: 'tokens' },
            ];
        const resourceRevision = revision(metrics.updated_at, session.updated_at);
        const page = arrayPage(values, cursor, query.limit, sessionId, query.view, resourceRevision);
        return {
          sessionId,
          revision: resourceRevision,
          view: query.view,
          metrics: page.items,
          tools: [],
          inputs: [],
          pageInfo: page.pageInfo,
        };
      }
      if (query.view === 'tools') {
        const page = await this.store.listToolCallSummaries(
          sessionId,
          cursor?.offset ?? 0,
          query.limit,
        );
        const resourceRevision = Math.max(revision(session.updated_at), page.revision);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'tools',
          metrics: [],
          tools: page.items.map((item) => ({
            name: item.name,
            calls: item.count,
            failures: item.errorCount + item.refusedCount + item.propagatedFailureCount,
            durationMs: null,
            inputBytes: null,
            outputBytes: null,
          })),
          inputs: [],
          pageInfo: {
            totalCount: page.totalCount,
            nextCursor: page.nextOffset == null ? null : encodeCursor({
              version: 1,
              sessionId,
              view: query.view,
              revision: resourceRevision,
              offset: page.nextOffset,
              sourceCursor: null,
            }),
          },
        };
      }

      const inputs = await this.store.listSessionInputs(sessionId);
      const resourceRevision = revision(session.updated_at, ...inputs.map((input) => input.created_at));
      const page = arrayPage(inputs, cursor, query.limit, sessionId, query.view, resourceRevision);
      return {
        sessionId,
        revision: resourceRevision,
        view: 'inputs',
        metrics: [],
        tools: [],
        inputs: page.items.map((input) => ({
          id: input.id,
          label: input.source_label,
          mediaType: 'text/plain',
          sizeBytes: Buffer.byteLength(input.content, 'utf8'),
          occurredAt: input.created_at,
          redacted: true,
        })),
        pageInfo: page.pageInfo,
      };
    });
  }

  configuration(
    sessionId: SessionId,
    query: SessionWorkbenchConfigurationQuery,
  ): Promise<SessionWorkbenchConfigurationResource> {
    return this.coalesce(coalescedKey('configuration', sessionId, query), async () => {
      const session = await this.requireSession(sessionId);
      const cursor = decodeCursor(query.cursor, sessionId, query.view);
      if (query.view === 'skills') {
        const explicit = activeSkillIds(session);
        const page = this.skillCatalog.listSkillSummaries({
          scopes: scopesFor(session, this.isCurrentProject),
          offset: cursor?.offset ?? 0,
          limit: query.limit,
        });
        const resourceRevision = Math.max(revision(session.updated_at), page.revision);
        assertRevision(cursor, resourceRevision, sessionId, query.view);
        return {
          sessionId,
          revision: resourceRevision,
          view: 'skills',
          skills: page.items.map((skill) => ({
            id: skill.id,
            name: skill.name,
            enabled: explicit?.has(skill.id) ?? skill.enabled,
            available: true,
            unavailableReason: null,
          })),
          tools: [],
          pageInfo: {
            totalCount: page.totalCount,
            nextCursor: page.nextOffset == null ? null : encodeCursor({
              version: 1,
              sessionId,
              view: query.view,
              revision: resourceRevision,
              offset: page.nextOffset,
              sourceCursor: null,
            }),
          },
        };
      }

      const disabled = await this.store.getSessionDisabledTools(sessionId);
      const tools = this.listTools().sort((left, right) =>
        left.tier.localeCompare(right.tier) || left.name.localeCompare(right.name));
      const resourceRevision = revision(session.updated_at);
      const page = arrayPage(tools, cursor, query.limit, sessionId, query.view, resourceRevision);
      return {
        sessionId,
        revision: resourceRevision,
        view: 'tools',
        skills: [],
        tools: page.items.map((tool) => ({
          id: tool.name,
          name: tool.name,
          enabled: !disabled.has(tool.name),
          permission: disabled.has(tool.name)
            ? 'deny'
            : session.tool_permission_mode === 'ask'
              ? 'ask'
              : 'allow',
          available: true,
          unavailableReason: null,
        })),
        pageInfo: page.pageInfo,
      };
    });
  }

  private async requireSession(sessionId: SessionId): Promise<FsCoderSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new SessionWorkbenchQueryError(
        'session_not_found',
        404,
        false,
        'session not found',
        { sessionId },
      );
    }
    return session;
  }

  private coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.coalesced.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = load();
    if (this.coalesced.size >= MAX_COALESCED_READS) return promise;
    this.coalesced.set(key, promise);
    void promise.finally(() => {
      if (this.coalesced.get(key) === promise) this.coalesced.delete(key);
    }).catch(() => undefined);
    return promise;
  }
}
