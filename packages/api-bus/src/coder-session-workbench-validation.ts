import type {
  SessionWorkbenchBootstrap,
  SessionWorkbenchCommandResult,
  SessionWorkbenchConfigurationResource,
  SessionWorkbenchContextResource,
  SessionWorkbenchEvent,
  SessionWorkbenchEventPage,
  SessionWorkbenchExecutionResource,
  SessionWorkbenchInsightsResource,
  SessionWorkbenchSessionPage,
} from './coder-session-workbench.js';
import { SESSION_WORKBENCH_CONTRACT_VERSION } from './coder-session-workbench.js';

type JsonObject = Record<string, unknown>;

export class SessionWorkbenchResponseValidationError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(`${path} ${message}`);
  }
}

function object(value: unknown, path: string): JsonObject {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionWorkbenchResponseValidationError(path, 'must be an object');
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SessionWorkbenchResponseValidationError(path, 'must be an array');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new SessionWorkbenchResponseValidationError(path, 'must be a string');
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SessionWorkbenchResponseValidationError(path, 'must be a boolean');
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionWorkbenchResponseValidationError(path, 'must be a non-negative safe integer');
  }
  return Number(value);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessionWorkbenchResponseValidationError(path, 'must be a finite number');
  }
  return value;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path);
}

function nullableFiniteNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function positiveRevision(value: unknown, path: string): number {
  const parsed = integer(value, path);
  if (parsed <= 0) throw new SessionWorkbenchResponseValidationError(path, 'must be positive');
  return parsed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new SessionWorkbenchResponseValidationError(path, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function contractVersion(value: unknown, path: string): void {
  if (value !== SESSION_WORKBENCH_CONTRACT_VERSION) {
    throw new SessionWorkbenchResponseValidationError(path, 'uses an unsupported contract version');
  }
}

function pageInfo(value: unknown, path: string): void {
  const item = object(value, path);
  nullableString(item.nextCursor, `${path}.nextCursor`);
  nullableInteger(item.totalCount, `${path}.totalCount`);
}

function runState(value: unknown, path: string): void {
  const item = object(value, path);
  boolean(item.active, `${path}.active`);
  if (item.waitingForInput !== null) boolean(item.waitingForInput, `${path}.waitingForInput`);
  nullableString(item.startedAt, `${path}.startedAt`);
  nullableString(item.lastEventAt, `${path}.lastEventAt`);
}

function badgeCount(value: unknown, path: string): void {
  const item = object(value, path);
  const availability = oneOf(item.availability, ['available', 'pending'], `${path}.availability`);
  if (availability === 'available') integer(item.value, `${path}.value`);
  else oneOf(item.reason, [
    'event_projection_pending',
    'snapshot_projection_pending',
    'subagent_projection_pending',
    'configuration_projection_pending',
  ], `${path}.reason`);
}

function sessionSummary(value: unknown, path: string): string {
  const item = object(value, path);
  const id = string(item.sessionId, `${path}.sessionId`);
  if (item.projectId !== null) integer(item.projectId, `${path}.projectId`);
  nullableString(item.workspaceLabel, `${path}.workspaceLabel`);
  nullableString(item.groupId, `${path}.groupId`);
  string(item.title, `${path}.title`);
  string(item.provider, `${path}.provider`);
  string(item.model, `${path}.model`);
  string(item.status, `${path}.status`);
  boolean(item.archived, `${path}.archived`);
  boolean(item.favorite, `${path}.favorite`);
  const badges = object(item.badges, `${path}.badges`);
  const badgeAvailability = oneOf(
    badges.availability,
    ['available', 'pending'],
    `${path}.badges.availability`,
  );
  if (badgeAvailability === 'available') {
    integer(badges.unreadCount, `${path}.badges.unreadCount`);
    integer(badges.errorCount, `${path}.badges.errorCount`);
    integer(badges.warningCount, `${path}.badges.warningCount`);
  } else {
    oneOf(badges.reason, ['event_projection_pending'], `${path}.badges.reason`);
  }
  runState(item.run, `${path}.run`);
  string(item.createdAt, `${path}.createdAt`);
  string(item.updatedAt, `${path}.updatedAt`);
  return id;
}

export function validateSessionWorkbenchSessionPage(value: unknown): SessionWorkbenchSessionPage {
  const result = object(value, '$');
  contractVersion(result.contractVersion, '$.contractVersion');
  array(result.items, '$.items').forEach((item, index) => sessionSummary(item, `$.items[${index}]`));
  array(result.groups, '$.groups').forEach((value, index) => {
    const item = object(value, `$.groups[${index}]`);
    string(item.id, `$.groups[${index}].id`);
    string(item.label, `$.groups[${index}].label`);
    oneOf(item.kind, ['session-group', 'workspace', 'ungrouped'], `$.groups[${index}].kind`);
    integer(item.totalCount, `$.groups[${index}].totalCount`);
    integer(item.activeCount, `$.groups[${index}].activeCount`);
    integer(item.errorCount, `$.groups[${index}].errorCount`);
  });
  integer(result.totalCount, '$.totalCount');
  nullableString(result.nextCursor, '$.nextCursor');
  string(result.queryRevision, '$.queryRevision');
  return value as SessionWorkbenchSessionPage;
}

export function validateSessionWorkbenchBootstrap(value: unknown): SessionWorkbenchBootstrap {
  const result = object(value, '$');
  contractVersion(result.contractVersion, '$.contractVersion');
  const sessionId = string(result.sessionId, '$.sessionId');
  positiveRevision(result.revision, '$.revision');
  if (sessionSummary(result.session, '$.session') !== sessionId) {
    throw new SessionWorkbenchResponseValidationError('$.session.sessionId', 'must match $.sessionId');
  }
  const capabilities = object(result.capabilities, '$.capabilities');
  for (const key of [
    'canShowContext', 'canShowExecution', 'canShowInsights', 'canShowPreview',
    'canShowDiagram', 'canConfigureTools', 'canConfigureSkills', 'canManageSnapshots',
  ]) boolean(capabilities[key], `$.capabilities.${key}`);
  array(capabilities.pluginDestinations, '$.capabilities.pluginDestinations').forEach((value, index) => {
    const item = object(value, `$.capabilities.pluginDestinations[${index}]`);
    string(item.destinationId, `$.capabilities.pluginDestinations[${index}].destinationId`);
    string(item.pluginId, `$.capabilities.pluginDestinations[${index}].pluginId`);
    string(item.label, `$.capabilities.pluginDestinations[${index}].label`);
    string(item.iconId, `$.capabilities.pluginDestinations[${index}].iconId`);
    oneOf(item.preferredWidth, ['compact', 'standard', 'wide'], `$.capabilities.pluginDestinations[${index}].preferredWidth`);
  });
  const badges = object(result.badges, '$.badges');
  for (const key of [
    'unreadNotifications', 'executionErrors', 'executionWarnings', 'activeSubagents',
    'chapters', 'pendingSnapshots', 'invalidConfiguration',
  ]) badgeCount(badges[key], `$.badges.${key}`);
  const severity = object(badges.highestSeverity, '$.badges.highestSeverity');
  const severityAvailability = oneOf(severity.availability, ['available', 'pending'], '$.badges.highestSeverity.availability');
  if (severityAvailability === 'available' && severity.value !== null) {
    oneOf(severity.value, ['info', 'success', 'warning', 'error'], '$.badges.highestSeverity.value');
  } else if (severityAvailability === 'pending') {
    oneOf(severity.reason, ['event_projection_pending'], '$.badges.highestSeverity.reason');
  }
  const summary = object(result.summary, '$.summary');
  if (string(summary.sessionId, '$.summary.sessionId') !== sessionId) {
    throw new SessionWorkbenchResponseValidationError('$.summary.sessionId', 'must match $.sessionId');
  }
  positiveRevision(summary.revision, '$.summary.revision');
  array(summary.tasks, '$.summary.tasks').forEach((value, index) => {
    const task = object(value, `$.summary.tasks[${index}]`);
    string(task.id, `$.summary.tasks[${index}].id`);
    string(task.title, `$.summary.tasks[${index}].title`);
    oneOf(task.status, ['pending', 'in_progress', 'completed', 'blocked'], `$.summary.tasks[${index}].status`);
  });
  const processes = object(summary.processes, '$.summary.processes');
  const processAvailability = oneOf(
    processes.availability,
    ['available', 'pending'],
    '$.summary.processes.availability',
  );
  if (processAvailability === 'available') {
    array(processes.items, '$.summary.processes.items').forEach((item, index) => {
      processSummary(item, `$.summary.processes.items[${index}]`);
    });
  } else {
    oneOf(
      processes.reason,
      ['execution_resource_not_loaded'],
      '$.summary.processes.reason',
    );
  }
  const revisions = object(result.resourceRevisions, '$.resourceRevisions');
  for (const key of ['summary', 'context', 'execution', 'insights', 'canvas', 'configuration', 'navigator']) {
    positiveRevision(revisions[key], `$.resourceRevisions.${key}`);
  }
  nullableString(result.persistedEventCursor, '$.persistedEventCursor');
  array(result.linkedProjects, '$.linkedProjects').forEach((value, index) => {
    const project = object(value, `$.linkedProjects[${index}]`);
    integer(project.projectId, `$.linkedProjects[${index}].projectId`);
    string(project.name, `$.linkedProjects[${index}].name`);
    string(project.rootLabel, `$.linkedProjects[${index}].rootLabel`);
    boolean(project.primary, `$.linkedProjects[${index}].primary`);
    boolean(project.focused, `$.linkedProjects[${index}].focused`);
  });
  if (result.focusedProjectId !== null) integer(result.focusedProjectId, '$.focusedProjectId');
  return value as SessionWorkbenchBootstrap;
}

function resourceEnvelope(value: unknown): { result: JsonObject; sessionId: string; revision: number; view: string } {
  const result = object(value, '$');
  const sessionId = string(result.sessionId, '$.sessionId');
  const resourceRevision = positiveRevision(result.revision, '$.revision');
  const view = string(result.view, '$.view');
  pageInfo(result.pageInfo, '$.pageInfo');
  return { result, sessionId, revision: resourceRevision, view };
}

const PROCESS_STATUSES = [
  'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled',
] as const;

function processSummary(value: unknown, path: string): void {
  const item = object(value, path);
  string(item.id, `${path}.id`);
  oneOf(
    item.labelKey,
    ['execution.process.automatic', 'execution.process.inlineAll'],
    `${path}.labelKey`,
  );
  oneOf(item.status, PROCESS_STATUSES, `${path}.status`);
  nullableString(item.startedAt, `${path}.startedAt`);
}

const EXECUTION_CATEGORIES = [
  'route', 'pool', 'worker', 'runner', 'tool', 'quality', 'provider', 'lifecycle', 'message', 'other',
] as const;

const SEVERITIES = ['info', 'success', 'warning', 'error'] as const;

function executionEntry(value: unknown, path: string): void {
  const item = object(value, path);
  string(item.id, `${path}.id`);
  integer(item.seq, `${path}.seq`);
  string(item.occurredAt, `${path}.occurredAt`);
  oneOf(item.category, EXECUTION_CATEGORIES, `${path}.category`);
  oneOf(item.severity, SEVERITIES, `${path}.severity`);
  nullableString(item.operationId, `${path}.operationId`);
  string(item.title, `${path}.title`);
  string(item.message, `${path}.message`);
  nullableFiniteNumber(item.durationMs, `${path}.durationMs`);
  boolean(item.retryable, `${path}.retryable`);
}

export function validateSessionWorkbenchContextResource(value: unknown): SessionWorkbenchContextResource {
  const { result, view } = resourceEnvelope(value);
  oneOf(view, ['files', 'skills', 'chapters', 'plans', 'drive'], '$.view');
  if (view === 'files') {
    array(result.files, '$.files').forEach((value, index) => {
      const item = object(value, `$.files[${index}]`);
      string(item.id, `$.files[${index}].id`);
      string(item.displayPath, `$.files[${index}].displayPath`);
      oneOf(item.kind, ['active', 'open', 'selected', 'attached', 'referenced'], `$.files[${index}].kind`);
      nullableInteger(item.startLine, `$.files[${index}].startLine`);
      nullableInteger(item.endLine, `$.files[${index}].endLine`);
    });
  } else if (view === 'skills') {
    array(result.skills, '$.skills').forEach((value, index) => {
      const item = object(value, `$.skills[${index}]`);
      string(item.id, `$.skills[${index}].id`);
      string(item.name, `$.skills[${index}].name`);
      oneOf(item.source, ['bundled', 'personal', 'plugin', 'workspace'], `$.skills[${index}].source`);
      boolean(item.active, `$.skills[${index}].active`);
    });
  } else if (view === 'chapters') {
    array(result.chapters, '$.chapters').forEach((value, index) => {
      const item = object(value, `$.chapters[${index}]`);
      string(item.id, `$.chapters[${index}].id`);
      string(item.title, `$.chapters[${index}].title`);
      string(item.status, `$.chapters[${index}].status`);
      string(item.updatedAt, `$.chapters[${index}].updatedAt`);
    });
  } else if (view === 'plans') {
    array(result.plans, '$.plans').forEach((value, index) => {
      const item = object(value, `$.plans[${index}]`);
      string(item.id, `$.plans[${index}].id`);
      string(item.title, `$.plans[${index}].title`);
      oneOf(item.status, ['pending', 'approved', 'rejected', 'aborted'], `$.plans[${index}].status`);
      string(item.updatedAt, `$.plans[${index}].updatedAt`);
    });
  } else {
    const drive = object(result.drive, '$.drive');
    boolean(drive.available, '$.drive.available');
    integer(drive.entryCount, '$.drive.entryCount');
    nullableString(drive.lastUpdatedAt, '$.drive.lastUpdatedAt');
  }
  return value as SessionWorkbenchContextResource;
}

export function validateSessionWorkbenchExecutionResource(value: unknown): SessionWorkbenchExecutionResource {
  const { result, view } = resourceEnvelope(value);
  oneOf(view, ['timeline', 'subagents', 'processes'], '$.view');
  runState(result.run, '$.run');
  if (view === 'timeline') {
    const entries = object(result.entries, '$.entries');
    oneOf(entries.availability, ['available', 'pending'], '$.entries.availability');
    if (entries.availability === 'available') {
      array(entries.items, '$.entries.items').forEach((value, index) => {
        executionEntry(value, `$.entries.items[${index}]`);
      });
    } else {
      oneOf(entries.reason, ['event_projection_pending'], '$.entries.reason');
    }
  } else if (view === 'subagents') {
    array(result.subagents, '$.subagents').forEach((value, index) => {
      const item = object(value, `$.subagents[${index}]`);
      string(item.id, `$.subagents[${index}].id`);
      string(item.label, `$.subagents[${index}].label`);
      oneOf(item.status, PROCESS_STATUSES, `$.subagents[${index}].status`);
      nullableString(item.startedAt, `$.subagents[${index}].startedAt`);
      nullableString(item.finishedAt, `$.subagents[${index}].finishedAt`);
    });
  } else {
    array(result.processes, '$.processes').forEach((item, index) => {
      processSummary(item, `$.processes[${index}]`);
    });
  }
  return value as SessionWorkbenchExecutionResource;
}

export function validateSessionWorkbenchInsightsResource(value: unknown): SessionWorkbenchInsightsResource {
  const { result, view } = resourceEnvelope(value);
  oneOf(view, ['overview', 'usage', 'tools', 'inputs'], '$.view');
  array(result.metrics, '$.metrics').forEach((value, index) => {
    const item = object(value, `$.metrics[${index}]`);
    string(item.id, `$.metrics[${index}].id`);
    string(item.labelKey, `$.metrics[${index}].labelKey`);
    finiteNumber(item.value, `$.metrics[${index}].value`);
    oneOf(item.unit, ['count', 'tokens', 'bytes', 'milliseconds', 'percent', 'currency'], `$.metrics[${index}].unit`);
  });
  array(result.tools, '$.tools').forEach((value, index) => {
    const item = object(value, `$.tools[${index}]`);
    string(item.name, `$.tools[${index}].name`);
    integer(item.calls, `$.tools[${index}].calls`);
    integer(item.failures, `$.tools[${index}].failures`);
    nullableFiniteNumber(item.durationMs, `$.tools[${index}].durationMs`);
    nullableInteger(item.inputBytes, `$.tools[${index}].inputBytes`);
    nullableInteger(item.outputBytes, `$.tools[${index}].outputBytes`);
  });
  array(result.inputs, '$.inputs').forEach((value, index) => {
    const item = object(value, `$.inputs[${index}]`);
    string(item.id, `$.inputs[${index}].id`);
    string(item.label, `$.inputs[${index}].label`);
    string(item.mediaType, `$.inputs[${index}].mediaType`);
    integer(item.sizeBytes, `$.inputs[${index}].sizeBytes`);
    string(item.occurredAt, `$.inputs[${index}].occurredAt`);
    boolean(item.redacted, `$.inputs[${index}].redacted`);
  });
  return value as SessionWorkbenchInsightsResource;
}

export function validateSessionWorkbenchConfigurationResource(value: unknown): SessionWorkbenchConfigurationResource {
  const { result, view } = resourceEnvelope(value);
  oneOf(view, ['skills', 'tools'], '$.view');
  array(result.skills, '$.skills').forEach((value, index) => {
    const item = object(value, `$.skills[${index}]`);
    string(item.id, `$.skills[${index}].id`);
    string(item.name, `$.skills[${index}].name`);
    boolean(item.enabled, `$.skills[${index}].enabled`);
    boolean(item.available, `$.skills[${index}].available`);
    nullableString(item.unavailableReason, `$.skills[${index}].unavailableReason`);
  });
  array(result.tools, '$.tools').forEach((value, index) => {
    const item = object(value, `$.tools[${index}]`);
    string(item.id, `$.tools[${index}].id`);
    string(item.name, `$.tools[${index}].name`);
    boolean(item.enabled, `$.tools[${index}].enabled`);
    oneOf(item.permission, ['deny', 'ask', 'allow'], `$.tools[${index}].permission`);
    boolean(item.available, `$.tools[${index}].available`);
    nullableString(item.unavailableReason, `$.tools[${index}].unavailableReason`);
  });
  return value as SessionWorkbenchConfigurationResource;
}

function validateEvent(value: unknown, path: string, pageSessionId: string): SessionWorkbenchEvent {
  const event = object(value, path);
  const sessionId = string(event.sessionId, `${path}.sessionId`);
  if (sessionId !== pageSessionId) {
    throw new SessionWorkbenchResponseValidationError(`${path}.sessionId`, 'must match $.sessionId');
  }
  string(event.busId, `${path}.busId`);
  integer(event.seq, `${path}.seq`);
  positiveRevision(event.revision, `${path}.revision`);
  string(event.occurredAt, `${path}.occurredAt`);
  const type = oneOf(event.type, [
    'summary.changed', 'context.changed', 'execution.event', 'insights.invalidated',
    'canvas.changed', 'configuration.changed', 'navigator.changed',
  ], `${path}.type`);
  const data = object(event.data, `${path}.data`);

  if (type === 'summary.changed') {
    oneOf(event.resource, ['summary'], `${path}.resource`);
    boolean(data.tasksChanged, `${path}.data.tasksChanged`);
    boolean(data.processesChanged, `${path}.data.processesChanged`);
  } else if (type === 'context.changed') {
    oneOf(event.resource, ['context'], `${path}.resource`);
    for (const key of ['filesChanged', 'skillsChanged', 'driveChanged', 'chaptersChanged', 'plansChanged']) {
      boolean(data[key], `${path}.data.${key}`);
    }
  } else if (type === 'execution.event') {
    oneOf(event.resource, ['execution'], `${path}.resource`);
    executionEntry(data, `${path}.data`);
  } else if (type === 'insights.invalidated') {
    oneOf(event.resource, ['insights'], `${path}.resource`);
    array(data.views, `${path}.data.views`).forEach((view, index) => {
      oneOf(view, ['overview', 'usage', 'tools', 'inputs'], `${path}.data.views[${index}]`);
    });
    oneOf(data.reason, ['turn_committed', 'tool_stats_changed', 'usage_changed'], `${path}.data.reason`);
  } else if (type === 'canvas.changed') {
    oneOf(event.resource, ['canvas'], `${path}.resource`);
    boolean(data.previewAvailable, `${path}.data.previewAvailable`);
    boolean(data.diagramAvailable, `${path}.data.diagramAvailable`);
    nullableString(data.activeArtifactId, `${path}.data.activeArtifactId`);
  } else if (type === 'configuration.changed') {
    oneOf(event.resource, ['configuration'], `${path}.resource`);
    array(data.views, `${path}.data.views`).forEach((view, index) => {
      oneOf(view, ['skills', 'tools'], `${path}.data.views[${index}]`);
    });
  } else {
    oneOf(event.resource, ['navigator'], `${path}.resource`);
    for (const key of [
      'titleChanged', 'statusChanged', 'favoriteChanged', 'archivedChanged',
      'groupChanged', 'unreadChanged',
    ]) boolean(data[key], `${path}.data.${key}`);
  }
  return value as SessionWorkbenchEvent;
}

export function validateSessionWorkbenchEventPage(value: unknown): SessionWorkbenchEventPage {
  const page = object(value, '$');
  contractVersion(page.contractVersion, '$.contractVersion');
  const sessionId = string(page.sessionId, '$.sessionId');
  positiveRevision(page.revision, '$.revision');
  array(page.events, '$.events').forEach((event, index) => {
    validateEvent(event, `$.events[${index}]`, sessionId);
  });
  nullableString(page.nextCursor, '$.nextCursor');
  nullableInteger(page.totalCount, '$.totalCount');
  boolean(page.replayGap, '$.replayGap');
  return value as SessionWorkbenchEventPage;
}

export function validateSessionWorkbenchCommandResult(value: unknown): SessionWorkbenchCommandResult {
  const result = object(value, '$');
  string(result.commandId, '$.commandId');
  const sessionId = string(result.sessionId, '$.sessionId');
  const ok = boolean(result.ok, '$.ok');
  if (ok) {
    positiveRevision(result.revision, '$.revision');
    if (result.createdSessionId !== undefined) string(result.createdSessionId, '$.createdSessionId');
  } else {
    const error = object(result.error, '$.error');
    string(error.code, '$.error.code');
    string(error.message, '$.error.message');
    boolean(error.retryable, '$.error.retryable');
    if (string(error.sessionId, '$.error.sessionId') !== sessionId) {
      throw new SessionWorkbenchResponseValidationError('$.error.sessionId', 'must match $.sessionId');
    }
    if (error.resource !== null) {
      oneOf(
        error.resource,
        ['summary', 'context', 'execution', 'insights', 'canvas', 'configuration', 'navigator'],
        '$.error.resource',
      );
    }
  }
  return value as SessionWorkbenchCommandResult;
}

export function validateSessionWorkbenchCommandResults(value: unknown): SessionWorkbenchCommandResult[] {
  return array(value, '$').map((result, index) => {
    try {
      return validateSessionWorkbenchCommandResult(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchResponseValidationError) {
        throw new SessionWorkbenchResponseValidationError(
          `$[${index}]${error.path === '$' ? '' : error.path.slice(1)}`,
          error.message.slice(error.path.length + 1),
        );
      }
      throw error;
    }
  });
}
