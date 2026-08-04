import { addBusEventSink, type BufferedEvent, type CoderRunBus } from '../coder-bus.js';
import { publishNotificationRuntimeEvent } from './notification-event-bus.js';
import {
  flushRuntimeEventLogWrites,
  persistRuntimeEvent,
  readPersistedRuntimeEvents,
  registerRuntimeEventLog,
  resetRuntimeEventLogStorage,
  type PersistableRuntimeEvent,
  type RuntimeEventLogLocation,
} from './runtime-event-log-storage.js';
import type { CompanySessionId, SessionId } from '@mcp/session-storage';

export type RuntimeLogKind = 'coder' | 'company';
export type RuntimeSessionId = SessionId | CompanySessionId;

export interface RuntimeEventEnvelope extends BufferedEvent {
  /** Stable identity of the run bus. Older persisted rows may omit it. */
  busId?: string;
  ts: number;
  kind: RuntimeLogKind;
  sessionId: RuntimeSessionId;
  opId?: string;
  groupId?: string;
  agentIndex?: number;
}

const CAP_PER_SESSION = 10_000;
const EVICT_BATCH = 1_000;
const MAX_MEMORY_SESSIONS = 32;
const MAX_PROGRESS_SAMPLES = 5_000;

const MAX_EVENT_BYTES = readPositiveInt('MCP_RUNTIME_LOG_MAX_EVENT_BYTES', 128 * 1024, 4 * 1024);
const MAX_EVENT_PREVIEW_CHARS = 16 * 1024;
const PROGRESS_SAMPLE_MS = readPositiveInt('MCP_RUNTIME_LOG_PROGRESS_SAMPLE_MS', 5_000, 250);

const logs = new Map<string, RuntimeEventEnvelope[]>();
const logTouched = new Map<string, number>();
const progressSamples = new Map<string, { at: number; signature: string }>();
const activeLogRefs = new Map<string, number>();
let touchSeq = 0;

// Per-token deltas are reconstructable from persisted assistant messages and
// provide no diagnostic value in a second append-only file. The coder bus
// exposes them as `text`/`thinking`; company envelopes retain the runner names
// `text_delta`/`thinking_delta`, so both vocabularies must be covered.
const SKIP_DELTAS = process.env.MCP_RUNTIME_LOG_SKIP_DELTAS !== '0';
const RECONSTRUCTABLE_DELTAS = new Set([
  'text',
  'thinking',
  'text_delta',
  'thinking_delta',
]);

interface RuntimeEventView {
  event: string;
  data: Record<string, unknown>;
  scope: string;
}

export function installRuntimeEventLog(
  bus: CoderRunBus,
  kind: RuntimeLogKind,
  sessionId: RuntimeSessionId,
  location: RuntimeEventLogLocation,
): () => void {
  const key = logKey(kind, sessionId);
  activeLogRefs.set(key, (activeLogRefs.get(key) ?? 0) + 1);
  const detachStorage = registerRuntimeEventLog(location);

  const detachSink = addBusEventSink(bus, (ev) => {
    if (!shouldCaptureRuntimeEvent(ev, key)) return;
    const env = enrichEvent(ev, bus.busId, kind, sessionId);
    publishNotificationRuntimeEvent(env);

    const prepared = prepareRuntimeEvent(env);
    appendInMemory(key, prepared.event);
    persistRuntimeEvent(prepared, location);
  });

  return () => {
    detachSink();
    const refs = (activeLogRefs.get(key) ?? 1) - 1;
    if (refs > 0) activeLogRefs.set(key, refs);
    else activeLogRefs.delete(key);
    detachStorage();
  };
}

export async function getRuntimeEventLog(
  kind: RuntimeLogKind,
  sessionId: RuntimeSessionId,
  location: RuntimeEventLogLocation,
): Promise<RuntimeEventEnvelope[]> {
  const persisted = await readPersistedRuntimeEvents(
    kind,
    sessionId,
    location,
  );
  const live = logs.get(logKey(kind, sessionId)) ?? [];
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;
  const seen = new Set(persisted.map(eventKey));
  return [...persisted, ...live.filter((event) => !seen.has(eventKey(event)))];
}

export function runtimeEventsToJsonl(events: RuntimeEventEnvelope[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

export function summarizeRuntimeEvents(events: RuntimeEventEnvelope[]): Record<string, unknown> {
  const lastEventByOperation = new Map<string, RuntimeEventEnvelope>();
  const lastEventByAgent = new Map<string, RuntimeEventEnvelope>();
  const timeouts: RuntimeEventEnvelope[] = [];
  for (const event of events) {
    if (event.opId) lastEventByOperation.set(event.opId, event);
    if (event.groupId != null && event.agentIndex != null) {
      lastEventByAgent.set(`${event.groupId}:${event.agentIndex}`, event);
    }
    const raw = String(JSON.stringify(event.data) ?? '').toLowerCase();
    if (raw.includes('timeout') || raw.includes('timed_out') || raw.includes('stalled')) {
      timeouts.push(event);
    }
  }
  return {
    eventCount: events.length,
    firstTs: events[0]?.ts ?? null,
    lastTs: events.at(-1)?.ts ?? null,
    lastEventByOperation: Object.fromEntries(lastEventByOperation),
    lastEventByAgent: Object.fromEntries(lastEventByAgent),
    timeouts,
  };
}

function shouldCaptureRuntimeEvent(ev: BufferedEvent, logScope: string): boolean {
  const view = runtimeEventView(ev);
  if (SKIP_DELTAS && RECONSTRUCTABLE_DELTAS.has(view.event)) return false;

  if (view.event === 'agent_progress' && view.data.event === 'heartbeat') {
    const identity = `${String(view.data.groupId ?? '')}:${String(view.data.agentIndex ?? '')}`;
    const signature = [view.data.status, view.data.phase, view.data.lastToolName].map(String).join('|');
    return sampleProgress(`${logScope}:${view.scope}:agent:${identity}`, signature);
  }

  if (view.event === 'operation_progress') {
    const identity = String(view.data.opId ?? 'unknown');
    const signature = [view.data.status, view.data.phase, view.data.note].map(String).join('|');
    return sampleProgress(`${logScope}:${view.scope}:operation:${identity}`, signature);
  }

  if (view.event === 'tool_progress') {
    const identity = String(view.data.id ?? view.data.name ?? 'unknown');
    const signature = [view.data.name, view.data.note].map(String).join('|');
    return sampleProgress(`${logScope}:${view.scope}:tool:${identity}`, signature);
  }

  return true;
}

function runtimeEventView(ev: BufferedEvent): RuntimeEventView {
  if (ev.event !== 'agent_event') {
    return { event: ev.event, data: asRecord(ev.data), scope: 'master' };
  }
  const outer = asRecord(ev.data);
  return {
    event: typeof outer.event === 'string' ? outer.event : ev.event,
    data: asRecord(outer.data),
    scope: `${String(outer.agent ?? '')}:${String(outer.agentRunId ?? '')}`,
  };
}

function sampleProgress(key: string, signature: string, now = Date.now()): boolean {
  const previous = progressSamples.get(key);
  if (previous && previous.signature === signature && now - previous.at < PROGRESS_SAMPLE_MS) {
    return false;
  }
  // Refresh insertion order so the oldest inactive key is evicted first.
  progressSamples.delete(key);
  progressSamples.set(key, { at: now, signature });
  if (progressSamples.size > MAX_PROGRESS_SAMPLES) {
    const oldest = progressSamples.keys().next().value as string | undefined;
    if (oldest) progressSamples.delete(oldest);
  }
  return true;
}

function enrichEvent(
  ev: BufferedEvent,
  busId: string,
  kind: RuntimeLogKind,
  sessionId: RuntimeSessionId,
): RuntimeEventEnvelope {
  const view = runtimeEventView(ev);
  return {
    ...ev,
    busId,
    ts: Date.now(),
    kind,
    sessionId,
    ...(typeof view.data.opId === 'string' ? { opId: view.data.opId } : {}),
    ...(typeof view.data.groupId === 'string' ? { groupId: view.data.groupId } : {}),
    ...(typeof view.data.agentIndex === 'number' ? { agentIndex: view.data.agentIndex } : {}),
  };
}

function prepareRuntimeEvent(event: RuntimeEventEnvelope): PersistableRuntimeEvent {
  const raw = JSON.stringify(event);
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes <= MAX_EVENT_BYTES) {
    return { event, line: `${raw}\n`, bytes: rawBytes + 1 };
  }

  const compact: RuntimeEventEnvelope = {
    ...event,
    data: {
      ...scalarMetadata(event.data),
      runtimeLogTruncated: true,
      originalBytes: rawBytes,
      preview: raw.slice(0, MAX_EVENT_PREVIEW_CHARS),
    },
  };
  const compactLine = `${JSON.stringify(compact)}\n`;
  return {
    event: compact,
    line: compactLine,
    bytes: Buffer.byteLength(compactLine, 'utf8'),
  };
}

function scalarMetadata(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const metadata: Record<string, unknown> = {};
  for (const key of [
    'id', 'name', 'opId', 'groupId', 'agentIndex', 'agent', 'agentRunId',
    'event', 'status', 'phase', 'level', 'category', 'message',
  ]) {
    const current = source[key];
    if (current == null || ['string', 'number', 'boolean'].includes(typeof current)) {
      if (current !== undefined) metadata[key] = current;
    }
  }
  return metadata;
}

function appendInMemory(key: string, event: RuntimeEventEnvelope): void {
  const list = logs.get(key) ?? [];
  list.push(event);
  // Evict in chunks instead of shifting ~10k array elements for every event
  // after the cap has been reached.
  if (list.length > CAP_PER_SESSION) list.splice(0, EVICT_BATCH);
  logs.set(key, list);
  logTouched.set(key, ++touchSeq);

  if (logs.size <= MAX_MEMORY_SESSIONS) return;
  let oldestKey: string | null = null;
  let oldestTouch = Number.POSITIVE_INFINITY;
  for (const candidate of logs.keys()) {
    const touched = logTouched.get(candidate) ?? 0;
    if (touched < oldestTouch && !activeLogRefs.has(candidate)) {
      oldestKey = candidate;
      oldestTouch = touched;
    }
  }
  if (oldestKey) clearMemoryLog(oldestKey);
}

function clearMemoryLog(key: string): void {
  logs.delete(key);
  logTouched.delete(key);
  for (const sampleKey of progressSamples.keys()) {
    if (sampleKey.startsWith(`${key}:`)) progressSamples.delete(sampleKey);
  }
}

function eventKey(event: RuntimeEventEnvelope): string {
  return `${event.ts}:${event.seq}:${event.event}`;
}

function logKey(kind: RuntimeLogKind, sessionId: RuntimeSessionId): string {
  return `${kind}:${sessionId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readPositiveInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

/** Test support: wait until every queued append/rotation has settled. */
export async function __flushRuntimeEventLogsForTests(): Promise<void> {
  await flushRuntimeEventLogWrites();
}

/** Test support: clear process-local caches after all writes have settled. */
export function __resetRuntimeEventLogsForTests(): void {
  logs.clear();
  logTouched.clear();
  progressSamples.clear();
  activeLogRefs.clear();
  touchSeq = 0;
  resetRuntimeEventLogStorage();
}
