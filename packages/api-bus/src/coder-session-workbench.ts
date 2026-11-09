import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts/ids.js';
import type { ApiContext, AsyncStream } from './common.js';
import { asSessionGroupId, type SessionGroupId } from './coder.js';

/** Version of the public Session Workbench wire contract. */
export const SESSION_WORKBENCH_CONTRACT_VERSION = 1 as const;
export const SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT = 50;
export const SESSION_WORKBENCH_PAGE_LIMIT_MAX = 100;
export const SESSION_WORKBENCH_EVENT_LIMIT_DEFAULT = 100;
export const SESSION_WORKBENCH_EVENT_LIMIT_MAX = 500;

export type SessionWorkbenchScope = 'project' | 'global';
export type SessionWorkbenchGroupBy = 'group' | 'workspace';
export type SessionWorkbenchSeverity = 'info' | 'success' | 'warning' | 'error';
export type SessionWorkbenchResource =
  | 'summary'
  | 'context'
  | 'execution'
  | 'insights'
  | 'canvas'
  | 'configuration'
  | 'navigator';
export type SessionWorkbenchDestination =
  | 'summary'
  | 'context'
  | 'execution'
  | 'insights'
  | 'canvas'
  | 'configuration'
  | `plugin:${string}`;

export interface SessionWorkbenchListQuery {
  scope: SessionWorkbenchScope;
  projectId?: number;
  cursor?: string;
  limit: number;
  query?: string;
  archived?: boolean;
  favorite?: boolean;
  status?: string;
  provider?: string;
  groupBy: SessionWorkbenchGroupBy;
}

/** Raw HTTP query shape accepted by the boundary parser. */
export interface SessionWorkbenchListRawQuery {
  scope?: string;
  project_id?: string;
  cursor?: string;
  limit?: string;
  query?: string;
  archived?: string;
  favorite?: string;
  status?: string;
  provider?: string;
  group_by?: string;
}

export interface SessionWorkbenchRunState {
  active: boolean;
  /** Null until the live event projection can distinguish waiting from running. */
  waitingForInput: boolean | null;
  startedAt: string | null;
  lastEventAt: string | null;
}

export type SessionWorkbenchListBadgeState =
  | {
      availability: 'available';
      unreadCount: number;
      errorCount: number;
      warningCount: number;
    }
  | {
      availability: 'pending';
      reason: 'event_projection_pending';
    };

export interface SessionWorkbenchSessionSummary {
  sessionId: SessionId;
  projectId: number | null;
  workspaceLabel: string | null;
  groupId: SessionGroupId | null;
  title: string;
  provider: string;
  model: string;
  status: string;
  archived: boolean;
  favorite: boolean;
  badges: SessionWorkbenchListBadgeState;
  run: SessionWorkbenchRunState;
  createdAt: string;
  updatedAt: string;
}

export interface SessionWorkbenchGroupSummary {
  id: string;
  label: string;
  kind: 'session-group' | 'workspace' | 'ungrouped';
  totalCount: number;
  activeCount: number;
  errorCount: number;
}

export interface SessionWorkbenchSessionPage {
  contractVersion: typeof SESSION_WORKBENCH_CONTRACT_VERSION;
  items: SessionWorkbenchSessionSummary[];
  groups: SessionWorkbenchGroupSummary[];
  totalCount: number;
  nextCursor: string | null;
  queryRevision: string;
}

export interface SessionWorkbenchPluginCapability {
  destinationId: `plugin:${string}`;
  pluginId: string;
  label: string;
  iconId: string;
  preferredWidth: 'compact' | 'standard' | 'wide';
}

export interface SessionWorkbenchCapabilities {
  canShowContext: boolean;
  canShowExecution: boolean;
  canShowInsights: boolean;
  canShowPreview: boolean;
  canShowDiagram: boolean;
  canConfigureTools: boolean;
  canConfigureSkills: boolean;
  canManageSnapshots: boolean;
  pluginDestinations: SessionWorkbenchPluginCapability[];
}

export type SessionWorkbenchBadgePendingReason =
  | 'event_projection_pending'
  | 'snapshot_projection_pending'
  | 'subagent_projection_pending'
  | 'configuration_projection_pending';

export type SessionWorkbenchBadgeCount =
  | { availability: 'available'; value: number }
  | { availability: 'pending'; reason: SessionWorkbenchBadgePendingReason };

export type SessionWorkbenchBadgeSeverity =
  | { availability: 'available'; value: SessionWorkbenchSeverity | null }
  | { availability: 'pending'; reason: 'event_projection_pending' };

/**
 * Bootstrap badge projection. Each value declares its own availability so a
 * bounded read cannot accidentally publish a fabricated zero while the event,
 * snapshot or configuration projection still belongs to a later resource.
 */
export interface SessionWorkbenchBadgeState {
  unreadNotifications: SessionWorkbenchBadgeCount;
  executionErrors: SessionWorkbenchBadgeCount;
  executionWarnings: SessionWorkbenchBadgeCount;
  activeSubagents: SessionWorkbenchBadgeCount;
  chapters: SessionWorkbenchBadgeCount;
  pendingSnapshots: SessionWorkbenchBadgeCount;
  invalidConfiguration: SessionWorkbenchBadgeCount;
  highestSeverity: SessionWorkbenchBadgeSeverity;
}

export interface SessionWorkbenchTaskSummary {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface SessionWorkbenchProcessSummary {
  id: string;
  /** Frontend i18n key; the backend never emits localized chrome text. */
  labelKey: 'execution.process.automatic' | 'execution.process.inlineAll';
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  startedAt: string | null;
}

export type SessionWorkbenchProcessState =
  | { availability: 'available'; items: SessionWorkbenchProcessSummary[] }
  | { availability: 'pending'; reason: 'execution_resource_not_loaded' };

export interface SessionWorkbenchSummaryResource {
  sessionId: SessionId;
  revision: number;
  tasks: SessionWorkbenchTaskSummary[];
  processes: SessionWorkbenchProcessState;
}

export interface SessionWorkbenchResourceRevisions {
  summary: number;
  context: number;
  execution: number;
  insights: number;
  canvas: number;
  configuration: number;
  navigator: number;
}

export interface SessionWorkbenchLinkedProject {
  projectId: number;
  name: string;
  rootLabel: string;
  primary: boolean;
  focused: boolean;
}

export interface SessionWorkbenchBootstrap {
  contractVersion: typeof SESSION_WORKBENCH_CONTRACT_VERSION;
  sessionId: SessionId;
  revision: number;
  session: SessionWorkbenchSessionSummary;
  capabilities: SessionWorkbenchCapabilities;
  badges: SessionWorkbenchBadgeState;
  summary: SessionWorkbenchSummaryResource;
  resourceRevisions: SessionWorkbenchResourceRevisions;
  persistedEventCursor: string | null;
  linkedProjects: SessionWorkbenchLinkedProject[];
  focusedProjectId: number | null;
}

export interface SessionWorkbenchPageInfo {
  nextCursor: string | null;
  /** Null when an exact filtered count would require an unbounded scan. */
  totalCount: number | null;
}

export interface SessionWorkbenchFileReference {
  id: string;
  displayPath: string;
  kind: 'active' | 'open' | 'selected' | 'attached' | 'referenced';
  startLine: number | null;
  endLine: number | null;
}

export interface SessionWorkbenchSkillReference {
  id: string;
  name: string;
  source: 'bundled' | 'personal' | 'plugin' | 'workspace';
  active: boolean;
}

export interface SessionWorkbenchChapterSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface SessionWorkbenchPlanSummary {
  id: string;
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'aborted';
  updatedAt: string;
}

export interface SessionWorkbenchDriveSummary {
  available: boolean;
  entryCount: number;
  lastUpdatedAt: string | null;
}

export type SessionWorkbenchContextView = 'files' | 'skills' | 'chapters' | 'plans' | 'drive';

interface SessionWorkbenchContextResourceBase {
  sessionId: SessionId;
  revision: number;
  view: SessionWorkbenchContextView;
  pageInfo: SessionWorkbenchPageInfo;
}

export type SessionWorkbenchContextResource =
  | (SessionWorkbenchContextResourceBase & {
      view: 'files';
      files: SessionWorkbenchFileReference[];
    })
  | (SessionWorkbenchContextResourceBase & {
      view: 'skills';
      skills: SessionWorkbenchSkillReference[];
    })
  | (SessionWorkbenchContextResourceBase & {
      view: 'chapters';
      chapters: SessionWorkbenchChapterSummary[];
    })
  | (SessionWorkbenchContextResourceBase & {
      view: 'plans';
      plans: SessionWorkbenchPlanSummary[];
    })
  | (SessionWorkbenchContextResourceBase & {
      view: 'drive';
      drive: SessionWorkbenchDriveSummary;
    });

export type SessionWorkbenchExecutionCategory =
  | 'route'
  | 'pool'
  | 'worker'
  | 'runner'
  | 'tool'
  | 'quality'
  | 'provider'
  | 'lifecycle'
  | 'message'
  | 'other';

export interface SessionWorkbenchExecutionEntry {
  id: string;
  seq: number;
  occurredAt: string;
  category: SessionWorkbenchExecutionCategory;
  severity: SessionWorkbenchSeverity;
  operationId: string | null;
  title: string;
  message: string;
  durationMs: number | null;
  retryable: boolean;
}

export interface SessionWorkbenchSubagentSummary {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
}

export type SessionWorkbenchExecutionView = 'timeline' | 'subagents' | 'processes';

interface SessionWorkbenchExecutionResourceBase {
  sessionId: SessionId;
  revision: number;
  view: SessionWorkbenchExecutionView;
  run: SessionWorkbenchRunState;
  pageInfo: SessionWorkbenchPageInfo;
}

export type SessionWorkbenchExecutionResource =
  | (SessionWorkbenchExecutionResourceBase & {
      view: 'timeline';
      entries:
        | { availability: 'available'; items: SessionWorkbenchExecutionEntry[] }
        | { availability: 'pending'; reason: 'event_projection_pending' };
    })
  | (SessionWorkbenchExecutionResourceBase & {
      view: 'subagents';
      subagents: SessionWorkbenchSubagentSummary[];
    })
  | (SessionWorkbenchExecutionResourceBase & {
      view: 'processes';
      processes: SessionWorkbenchProcessSummary[];
    });

export type SessionWorkbenchInsightsView = 'overview' | 'usage' | 'tools' | 'inputs';

export interface SessionWorkbenchInsightsMetric {
  id: string;
  /** Frontend i18n key; the backend never emits localized chrome text. */
  labelKey: string;
  value: number;
  unit: 'count' | 'tokens' | 'bytes' | 'milliseconds' | 'percent' | 'currency';
}

export interface SessionWorkbenchToolInsight {
  name: string;
  calls: number;
  failures: number;
  durationMs: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
}

export interface SessionWorkbenchCapturedInput {
  id: string;
  label: string;
  mediaType: string;
  sizeBytes: number;
  occurredAt: string;
  redacted: boolean;
}

export interface SessionWorkbenchInsightsResource {
  sessionId: SessionId;
  revision: number;
  view: SessionWorkbenchInsightsView;
  metrics: SessionWorkbenchInsightsMetric[];
  tools: SessionWorkbenchToolInsight[];
  inputs: SessionWorkbenchCapturedInput[];
  pageInfo: SessionWorkbenchPageInfo;
}

export type SessionWorkbenchConfigurationView = 'skills' | 'tools';

export interface SessionWorkbenchResourceRawQuery {
  view?: string;
  cursor?: string;
  limit?: string;
}

export interface SessionWorkbenchContextQuery {
  view: SessionWorkbenchContextView;
  cursor?: string;
  limit: number;
}

export interface SessionWorkbenchExecutionQuery {
  view: SessionWorkbenchExecutionView;
  cursor?: string;
  limit: number;
}

export interface SessionWorkbenchInsightsQuery {
  view: SessionWorkbenchInsightsView;
  cursor?: string;
  limit: number;
}

export interface SessionWorkbenchConfigurationQuery {
  view: SessionWorkbenchConfigurationView;
  cursor?: string;
  limit: number;
}

export interface SessionWorkbenchSkillConfiguration {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
}

export interface SessionWorkbenchToolConfiguration {
  id: string;
  name: string;
  enabled: boolean;
  permission: 'deny' | 'ask' | 'allow';
  available: boolean;
  unavailableReason: string | null;
}

export interface SessionWorkbenchConfigurationResource {
  sessionId: SessionId;
  revision: number;
  view: SessionWorkbenchConfigurationView;
  skills: SessionWorkbenchSkillConfiguration[];
  tools: SessionWorkbenchToolConfiguration[];
  pageInfo: SessionWorkbenchPageInfo;
}

export interface SessionWorkbenchEventRawQuery {
  cursor?: string;
  limit?: string;
  category?: string;
  level?: string;
  query?: string;
}

export interface SessionWorkbenchEventQuery {
  cursor?: string;
  limit: number;
  category?: SessionWorkbenchExecutionCategory;
  level?: SessionWorkbenchSeverity;
  query?: string;
}

interface SessionWorkbenchEventBase {
  sessionId: SessionId;
  busId: string;
  seq: number;
  revision: number;
  occurredAt: string;
}

export interface SessionWorkbenchSummaryChangedEvent extends SessionWorkbenchEventBase {
  type: 'summary.changed';
  resource: 'summary';
  data: {
    tasksChanged: boolean;
    processesChanged: boolean;
  };
}

export interface SessionWorkbenchContextChangedEvent extends SessionWorkbenchEventBase {
  type: 'context.changed';
  resource: 'context';
  data: {
    filesChanged: boolean;
    skillsChanged: boolean;
    driveChanged: boolean;
    chaptersChanged: boolean;
    plansChanged: boolean;
  };
}

export interface SessionWorkbenchExecutionEvent extends SessionWorkbenchEventBase {
  type: 'execution.event';
  resource: 'execution';
  data: SessionWorkbenchExecutionEntry;
}

export interface SessionWorkbenchInsightsInvalidatedEvent extends SessionWorkbenchEventBase {
  type: 'insights.invalidated';
  resource: 'insights';
  data: {
    views: SessionWorkbenchInsightsView[];
    reason: 'turn_committed' | 'tool_stats_changed' | 'usage_changed';
  };
}

export interface SessionWorkbenchCanvasChangedEvent extends SessionWorkbenchEventBase {
  type: 'canvas.changed';
  resource: 'canvas';
  data: {
    previewAvailable: boolean;
    diagramAvailable: boolean;
    activeArtifactId: string | null;
  };
}

export interface SessionWorkbenchConfigurationChangedEvent extends SessionWorkbenchEventBase {
  type: 'configuration.changed';
  resource: 'configuration';
  data: {
    views: SessionWorkbenchConfigurationView[];
  };
}

export interface SessionWorkbenchNavigatorChangedEvent extends SessionWorkbenchEventBase {
  type: 'navigator.changed';
  resource: 'navigator';
  data: {
    titleChanged: boolean;
    statusChanged: boolean;
    favoriteChanged: boolean;
    archivedChanged: boolean;
    groupChanged: boolean;
    unreadChanged: boolean;
  };
}

export type SessionWorkbenchEvent =
  | SessionWorkbenchSummaryChangedEvent
  | SessionWorkbenchContextChangedEvent
  | SessionWorkbenchExecutionEvent
  | SessionWorkbenchInsightsInvalidatedEvent
  | SessionWorkbenchCanvasChangedEvent
  | SessionWorkbenchConfigurationChangedEvent
  | SessionWorkbenchNavigatorChangedEvent;

export interface SessionWorkbenchEventPage {
  contractVersion: typeof SESSION_WORKBENCH_CONTRACT_VERSION;
  sessionId: SessionId;
  revision: number;
  events: SessionWorkbenchEvent[];
  nextCursor: string | null;
  totalCount: number | null;
  replayGap: boolean;
}

interface SessionWorkbenchCommandBase {
  commandId: string;
  sessionId: SessionId;
  expectedRevision?: number;
}

export type SessionWorkbenchCommand =
  | (SessionWorkbenchCommandBase & { type: 'rename'; title: string })
  | (SessionWorkbenchCommandBase & { type: 'set_favorite'; favorite: boolean })
  | (SessionWorkbenchCommandBase & { type: 'set_archived'; archived: boolean })
  | (SessionWorkbenchCommandBase & { type: 'move'; groupId: SessionGroupId | null })
  | (SessionWorkbenchCommandBase & { type: 'duplicate'; title?: string })
  | (SessionWorkbenchCommandBase & { type: 'set_skill_enabled'; skillId: string; enabled: boolean })
  | (SessionWorkbenchCommandBase & { type: 'set_tool_enabled'; toolId: string; enabled: boolean })
  | (SessionWorkbenchCommandBase & { type: 'mark_notifications_read'; throughSeq: number })
  | (SessionWorkbenchCommandBase & { type: 'dismiss_notification'; notificationId: string });

export interface SessionWorkbenchCommandError {
  code: string;
  message: string;
  retryable: boolean;
  sessionId: SessionId;
  resource: SessionWorkbenchResource | null;
}

export type SessionWorkbenchCommandResult =
  | {
      commandId: string;
      sessionId: SessionId;
      ok: true;
      revision: number;
      createdSessionId?: SessionId;
    }
  | {
      commandId: string;
      sessionId: SessionId;
      ok: false;
      error: SessionWorkbenchCommandError;
    };

const COMMAND_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commandObject(value: unknown, name: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function commandString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${name} exceeds ${maxLength} characters`);
  return normalized;
}

function commandBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function commandBase(value: Record<string, unknown>): SessionWorkbenchCommandBase {
  const commandId = commandString(value.commandId, 'commandId', 36).toLowerCase();
  if (!COMMAND_UUID_PATTERN.test(commandId)) throw new TypeError('commandId must be a canonical UUID');
  const sessionId = asSessionId(commandString(value.sessionId, 'sessionId', 36));
  const expectedRevision = value.expectedRevision;
  if (
    expectedRevision !== undefined
    && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) <= 0)
  ) throw new TypeError('expectedRevision must be a positive safe integer');
  return {
    commandId,
    sessionId,
    ...(expectedRevision === undefined ? {} : { expectedRevision: Number(expectedRevision) }),
  };
}

export function parseSessionWorkbenchCommand(value: unknown): SessionWorkbenchCommand {
  const raw = commandObject(value, 'command');
  const base = commandBase(raw);
  const type = commandString(raw.type, 'type', 80);
  if (type === 'rename') return { ...base, type, title: commandString(raw.title, 'title', 200) };
  if (type === 'set_favorite') return { ...base, type, favorite: commandBoolean(raw.favorite, 'favorite') };
  if (type === 'set_archived') return { ...base, type, archived: commandBoolean(raw.archived, 'archived') };
  if (type === 'move') {
    if (raw.groupId !== null && typeof raw.groupId !== 'string') {
      throw new TypeError('groupId must be a canonical UUID or null');
    }
    return {
      ...base,
      type,
      groupId: raw.groupId === null ? null : asSessionGroupId(commandString(raw.groupId, 'groupId', 36)),
    };
  }
  if (type === 'duplicate') {
    return {
      ...base,
      type,
      ...(raw.title === undefined ? {} : { title: commandString(raw.title, 'title', 200) }),
    };
  }
  if (type === 'set_skill_enabled') {
    return {
      ...base,
      type,
      skillId: commandString(raw.skillId, 'skillId', 200),
      enabled: commandBoolean(raw.enabled, 'enabled'),
    };
  }
  if (type === 'set_tool_enabled') {
    return {
      ...base,
      type,
      toolId: commandString(raw.toolId, 'toolId', 200),
      enabled: commandBoolean(raw.enabled, 'enabled'),
    };
  }
  if (type === 'mark_notifications_read') {
    if (!Number.isSafeInteger(raw.throughSeq) || Number(raw.throughSeq) < 0) {
      throw new TypeError('throughSeq must be a non-negative safe integer');
    }
    return { ...base, type, throughSeq: Number(raw.throughSeq) };
  }
  if (type === 'dismiss_notification') {
    return {
      ...base,
      type,
      notificationId: commandString(raw.notificationId, 'notificationId', 200),
    };
  }
  throw new TypeError('command type is not supported');
}

export function parseSessionWorkbenchCommandBatch(value: unknown): SessionWorkbenchCommand[] {
  const raw = commandObject(value, 'batch');
  if (!Array.isArray(raw.commands) || raw.commands.length < 1 || raw.commands.length > 100) {
    throw new TypeError('commands must contain between 1 and 100 items');
  }
  return raw.commands.map(parseSessionWorkbenchCommand);
}

export interface SessionWorkbenchApi {
  listSessions(input: SessionWorkbenchListQuery, ctx: ApiContext): Promise<SessionWorkbenchSessionPage>;
  bootstrap(input: { sessionId: SessionId }, ctx: ApiContext): Promise<SessionWorkbenchBootstrap>;
  context(
    input: { sessionId: SessionId } & SessionWorkbenchContextQuery,
    ctx: ApiContext,
  ): Promise<SessionWorkbenchContextResource>;
  execution(
    input: { sessionId: SessionId } & SessionWorkbenchExecutionQuery,
    ctx: ApiContext,
  ): Promise<SessionWorkbenchExecutionResource>;
  insights(
    input: { sessionId: SessionId } & SessionWorkbenchInsightsQuery,
    ctx: ApiContext,
  ): Promise<SessionWorkbenchInsightsResource>;
  configuration(
    input: { sessionId: SessionId } & SessionWorkbenchConfigurationQuery,
    ctx: ApiContext,
  ): Promise<SessionWorkbenchConfigurationResource>;
  events(
    input: { sessionId: SessionId } & SessionWorkbenchEventQuery,
    ctx: ApiContext,
  ): Promise<SessionWorkbenchEventPage>;
  attach(input: { sessionId: SessionId; cursor?: string }, ctx: ApiContext): AsyncStream<SessionWorkbenchEvent>;
  command(input: SessionWorkbenchCommand, ctx: ApiContext): Promise<SessionWorkbenchCommandResult>;
  batch(input: { commands: SessionWorkbenchCommand[] }, ctx: ApiContext): Promise<SessionWorkbenchCommandResult[]>;
}

function parseOptionalBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${name} must be true or false`);
}

function parsePositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new TypeError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedText(name: string, value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new TypeError(`${name} exceeds ${maxLength} characters`);
  return normalized;
}

function parseResourceQuery<TView extends string>(
  raw: SessionWorkbenchResourceRawQuery,
  views: readonly TView[],
  defaultView: TView,
): { view: TView; cursor?: string; limit: number } {
  const view = raw.view?.trim() || defaultView;
  if (!views.includes(view as TView)) throw new TypeError('view is not supported');
  const requestedLimit = parsePositiveInteger('limit', raw.limit);
  const cursor = parseBoundedText('cursor', raw.cursor, 512);
  return {
    view: view as TView,
    ...(cursor === undefined ? {} : { cursor }),
    limit: Math.min(requestedLimit ?? SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT, SESSION_WORKBENCH_PAGE_LIMIT_MAX),
  };
}

export function parseSessionWorkbenchContextQuery(
  raw: SessionWorkbenchResourceRawQuery,
): SessionWorkbenchContextQuery {
  return parseResourceQuery(raw, ['files', 'skills', 'chapters', 'plans', 'drive'], 'files');
}

export function parseSessionWorkbenchExecutionQuery(
  raw: SessionWorkbenchResourceRawQuery,
): SessionWorkbenchExecutionQuery {
  return parseResourceQuery(raw, ['timeline', 'subagents', 'processes'], 'timeline');
}

export function parseSessionWorkbenchInsightsQuery(
  raw: SessionWorkbenchResourceRawQuery,
): SessionWorkbenchInsightsQuery {
  return parseResourceQuery(raw, ['overview', 'usage', 'tools', 'inputs'], 'overview');
}

export function parseSessionWorkbenchConfigurationQuery(
  raw: SessionWorkbenchResourceRawQuery,
): SessionWorkbenchConfigurationQuery {
  return parseResourceQuery(raw, ['skills', 'tools'], 'skills');
}

/**
 * Parses the list query at the transport boundary and enforces the server-side
 * maximum independently of the caller.
 */
export function parseSessionWorkbenchListQuery(
  raw: SessionWorkbenchListRawQuery,
): SessionWorkbenchListQuery {
  if (raw.scope !== 'project' && raw.scope !== 'global') {
    throw new TypeError('scope must be project or global');
  }

  const projectId = parsePositiveInteger('project_id', raw.project_id);
  if (raw.scope === 'project' && projectId === undefined) {
    throw new TypeError('project_id is required for project scope');
  }

  const requestedLimit = parsePositiveInteger('limit', raw.limit);
  const groupBy = raw.group_by ?? (raw.scope === 'project' ? 'group' : 'workspace');
  if (groupBy !== 'group' && groupBy !== 'workspace') {
    throw new TypeError('group_by must be group or workspace');
  }

  return {
    scope: raw.scope,
    ...(projectId === undefined ? {} : { projectId }),
    ...(parseBoundedText('cursor', raw.cursor, 512) === undefined
      ? {}
      : { cursor: parseBoundedText('cursor', raw.cursor, 512) }),
    limit: Math.min(requestedLimit ?? SESSION_WORKBENCH_PAGE_LIMIT_DEFAULT, SESSION_WORKBENCH_PAGE_LIMIT_MAX),
    ...(parseBoundedText('query', raw.query, 200) === undefined
      ? {}
      : { query: parseBoundedText('query', raw.query, 200) }),
    ...(parseOptionalBoolean('archived', raw.archived) === undefined
      ? {}
      : { archived: parseOptionalBoolean('archived', raw.archived) }),
    ...(parseOptionalBoolean('favorite', raw.favorite) === undefined
      ? {}
      : { favorite: parseOptionalBoolean('favorite', raw.favorite) }),
    ...(parseBoundedText('status', raw.status, 80) === undefined
      ? {}
      : { status: parseBoundedText('status', raw.status, 80) }),
    ...(parseBoundedText('provider', raw.provider, 80) === undefined
      ? {}
      : { provider: parseBoundedText('provider', raw.provider, 80) }),
    groupBy,
  };
}

const EXECUTION_CATEGORIES: readonly SessionWorkbenchExecutionCategory[] = [
  'route', 'pool', 'worker', 'runner', 'tool', 'quality', 'provider', 'lifecycle', 'message', 'other',
];
const SEVERITIES: readonly SessionWorkbenchSeverity[] = ['info', 'success', 'warning', 'error'];

export function parseSessionWorkbenchEventQuery(
  raw: SessionWorkbenchEventRawQuery,
): SessionWorkbenchEventQuery {
  const requestedLimit = parsePositiveInteger('limit', raw.limit);
  const category = parseBoundedText('category', raw.category, 40);
  const level = parseBoundedText('level', raw.level, 20);
  if (category && !EXECUTION_CATEGORIES.includes(category as SessionWorkbenchExecutionCategory)) {
    throw new TypeError('category is not supported');
  }
  if (level && !SEVERITIES.includes(level as SessionWorkbenchSeverity)) {
    throw new TypeError('level is not supported');
  }

  const cursor = parseBoundedText('cursor', raw.cursor, 512);
  const query = parseBoundedText('query', raw.query, 200);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit: Math.min(requestedLimit ?? SESSION_WORKBENCH_EVENT_LIMIT_DEFAULT, SESSION_WORKBENCH_EVENT_LIMIT_MAX),
    ...(category === undefined ? {} : { category: category as SessionWorkbenchExecutionCategory }),
    ...(level === undefined ? {} : { level: level as SessionWorkbenchSeverity }),
    ...(query === undefined ? {} : { query }),
  };
}
