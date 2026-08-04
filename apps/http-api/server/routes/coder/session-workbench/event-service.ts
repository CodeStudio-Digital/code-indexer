import {
  SESSION_WORKBENCH_CONTRACT_VERSION,
  type SessionWorkbenchEvent,
  type SessionWorkbenchEventPage,
  type SessionWorkbenchEventQuery,
  type SessionWorkbenchExecutionCategory,
  type SessionWorkbenchExecutionEntry,
  type SessionWorkbenchSeverity,
} from '@mcp/api-bus';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type {
  PersistedRuntimeEventPage,
  PersistedRuntimeEventRecord,
} from '../../../../sse/runtime-event-log-storage.js';
import type { RuntimeEventEnvelope } from '../../../../sse/runtime-event-log.js';
import { SessionWorkbenchQueryError } from './query-service.js';

interface EventCursorPayload {
  version: 1;
  sessionId: string;
  sourceCursor: string;
  snapshotRevision: number;
  totalCount: number | null;
}

export interface SessionWorkbenchEventPageSource {
  listPage(
    sessionId: SessionId,
    input: { cursor?: string; limit: number },
  ): Promise<PersistedRuntimeEventPage>;
}

const MAX_SCANNED_EVENTS_PER_QUERY = 10_000;
const TITLE_LIMIT = 160;
const MESSAGE_LIMIT = 2_000;

function encodeCursor(payload: EventCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, sessionId: SessionId): EventCursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<EventCursorPayload>;
    if (
      parsed.version !== 1
      || parsed.sessionId !== sessionId
      || typeof parsed.sourceCursor !== 'string'
      || parsed.sourceCursor.length === 0
      || !Number.isSafeInteger(parsed.snapshotRevision)
      || (parsed.snapshotRevision ?? 0) <= 0
      || (parsed.totalCount !== null
        && (!Number.isSafeInteger(parsed.totalCount) || (parsed.totalCount ?? -1) < 0))
    ) throw new Error('invalid event cursor');
    return parsed as EventCursorPayload;
  } catch {
    throw new SessionWorkbenchQueryError(
      'invalid_cursor',
      400,
      false,
      'event cursor is malformed or belongs to another session',
      { sessionId },
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventView(envelope: RuntimeEventEnvelope): { name: string; data: Record<string, unknown> } {
  if (envelope.event !== 'agent_event') return { name: envelope.event, data: record(envelope.data) };
  const outer = record(envelope.data);
  return {
    name: typeof outer.event === 'string' ? outer.event : envelope.event,
    data: record(outer.data),
  };
}

function categoryFor(name: string, data: Record<string, unknown>): SessionWorkbenchExecutionCategory {
  if (name === 'worker_log') {
    const category = data.category;
    if (
      category === 'route' || category === 'pool' || category === 'worker'
      || category === 'runner' || category === 'tool' || category === 'quality'
      || category === 'provider' || category === 'lifecycle'
      || category === 'message' || category === 'other'
    ) return category;
  }
  if (name.startsWith('tool_') || name.startsWith('task_run_')) return 'tool';
  if (name.startsWith('operation_') || name === 'bt_state_dwell' || name === 'run_started' || name === 'done') {
    return 'runner';
  }
  if (name.startsWith('agent_') || name.startsWith('agents_')) return 'worker';
  if (name.startsWith('quality_') || name === 'tool_loop_intervention') return 'quality';
  if (name === 'provider_call' || name === 'provider_swapped' || name === 'fallback_activated') {
    return 'provider';
  }
  if (
    name === 'turn_start' || name === 'message_complete' || name === 'history_compacted'
    || name === 'auto_continue'
  ) return 'lifecycle';
  if (name === 'text' || name === 'thinking') return 'message';
  return 'other';
}

function severityFor(name: string, data: Record<string, unknown>): SessionWorkbenchSeverity {
  const level = data.level;
  if (level === 'error') return 'error';
  if (level === 'warn' || level === 'warning') return 'warning';
  if (level === 'success') return 'success';
  if (name === 'error' || name.endsWith('_failed') || name.endsWith('_error')) return 'error';
  if (name === 'warning' || name === 'tool_loop_intervention') return 'warning';
  if (name === 'done' || name.endsWith('_completed') || name.endsWith('_succeeded')) return 'success';
  return 'info';
}

function redact(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12})[A-Za-z0-9_-]+\b/g, '$1…[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[redacted]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]');
}

function boundedText(value: string, limit: number): string {
  const clean = redact(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' '));
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function firstString(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function duration(data: Record<string, unknown>): number | null {
  for (const key of ['durationMs', 'elapsedMs']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function projectSessionWorkbenchEvent(
  sessionId: SessionId,
  source: PersistedRuntimeEventRecord,
): SessionWorkbenchEvent {
  const view = eventView(source.event);
  const title = boundedText(view.name, TITLE_LIMIT);
  const message = boundedText(
    firstString(view.data, ['message', 'note', 'status', 'phase']) ?? view.name,
    MESSAGE_LIMIT,
  );
  const entry: SessionWorkbenchExecutionEntry = {
    id: source.id,
    seq: source.event.seq,
    occurredAt: new Date(source.event.ts).toISOString(),
    category: categoryFor(view.name, view.data),
    severity: severityFor(view.name, view.data),
    operationId: source.event.opId
      ?? (typeof view.data.opId === 'string' ? view.data.opId : null),
    title,
    message,
    durationMs: duration(view.data),
    retryable: view.data.retryable === true,
  };
  return {
    sessionId,
    busId: source.event.busId ?? `legacy:${source.id}`,
    seq: source.event.seq,
    revision: source.revision,
    occurredAt: entry.occurredAt,
    type: 'execution.event',
    resource: 'execution',
    data: entry,
  };
}

function matches(event: SessionWorkbenchEvent, query: SessionWorkbenchEventQuery): boolean {
  if (event.type !== 'execution.event') return true;
  if (query.category && event.data.category !== query.category) return false;
  if (query.level && event.data.severity !== query.level) return false;
  if (!query.query) return true;
  const needle = query.query.toLocaleLowerCase();
  return [event.data.title, event.data.message, event.data.operationId ?? '']
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

export class SessionWorkbenchEventService {
  constructor(private readonly source: SessionWorkbenchEventPageSource) {}

  async list(sessionId: SessionId, query: SessionWorkbenchEventQuery): Promise<SessionWorkbenchEventPage> {
    const cursor = decodeCursor(query.cursor, sessionId);
    let sourceCursor = cursor?.sourceCursor;
    let snapshotRevision = cursor?.snapshotRevision ?? 1;
    let totalCount = cursor?.totalCount ?? null;
    let scanned = 0;
    const events: SessionWorkbenchEvent[] = [];
    let nextSourceCursor: string | null = sourceCursor ?? null;

    while (events.length < query.limit && scanned < MAX_SCANNED_EVENTS_PER_QUERY) {
      const remaining = Math.min(
        query.limit - events.length,
        MAX_SCANNED_EVENTS_PER_QUERY - scanned,
      );
      const page = await this.source.listPage(sessionId, {
        ...(sourceCursor ? { cursor: sourceCursor } : {}),
        limit: remaining,
      });
      if (!cursor && scanned === 0 && page.items[0]) snapshotRevision = page.items[0].revision;
      if (!cursor && scanned === 0 && !query.category && !query.level && !query.query) {
        totalCount = page.totalCount;
      }
      scanned += page.items.length;
      for (const item of page.items) {
        const projected = projectSessionWorkbenchEvent(sessionId, item);
        if (matches(projected, query)) events.push(projected);
      }
      nextSourceCursor = page.nextCursor;
      if (!page.nextCursor || page.items.length === 0) break;
      sourceCursor = page.nextCursor;
    }

    return {
      contractVersion: SESSION_WORKBENCH_CONTRACT_VERSION,
      sessionId,
      revision: snapshotRevision,
      events,
      nextCursor: nextSourceCursor
        ? encodeCursor({
            version: 1,
            sessionId,
            sourceCursor: nextSourceCursor,
            snapshotRevision,
            totalCount,
          })
        : null,
      totalCount,
      replayGap: false,
    };
  }
}
