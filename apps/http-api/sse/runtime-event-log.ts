import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { addBusEventSink, type BufferedEvent, type CoderRunBus } from '../coder-bus.js';
import { publishNotificationRuntimeEvent } from './notification-event-bus.js';

export type RuntimeLogKind = 'coder' | 'company';

export interface RuntimeEventEnvelope extends BufferedEvent {
  ts: number;
  kind: RuntimeLogKind;
  sessionId: number;
  opId?: string;
  groupId?: string;
  agentIndex?: number;
}

const CAP_PER_SESSION = 10_000;
const logs = new Map<string, RuntimeEventEnvelope[]>();
const writeChains = new Map<string, Promise<void>>();
const ensuredDirs = new Set<string>();

// Anti-freeze: the highest-volume events are per-token text/thinking deltas.
// They are fully reconstructable from the persisted assistant messages (the
// same rationale the SSE replay buffer relies on — see coder-bus.ts), so the
// diagnostic runtime log never needs them. Dropping them here removes the bulk
// of the per-event enrich + file-append + memory churn this sink does on the
// MAIN thread during a multi-agent run. Set MCP_RUNTIME_LOG_SKIP_DELTAS=0 to
// keep them (e.g. when debugging token streaming itself).
const SKIP_DELTAS = process.env.MCP_RUNTIME_LOG_SKIP_DELTAS !== '0';
const RECONSTRUCTABLE_DELTAS = new Set(['text_delta', 'thinking_delta']);

/**
 * True for per-token deltas on either path: the coder path emits the runner
 * event directly (`ev.event === 'text_delta'`); the company path wraps it as
 * `agent_event` with the runner event in `ev.data.event`.
 */
function isReconstructableDelta(ev: BufferedEvent): boolean {
  if (RECONSTRUCTABLE_DELTAS.has(ev.event)) return true;
  if (ev.event === 'agent_event') {
    const d = ev.data as { event?: unknown } | null;
    return !!d && typeof d === 'object' && typeof d.event === 'string'
      && RECONSTRUCTABLE_DELTAS.has(d.event);
  }
  return false;
}

export function installRuntimeEventLog(
  bus: CoderRunBus,
  kind: RuntimeLogKind,
  sessionId: number,
): () => void {
  return addBusEventSink(bus, (ev) => {
    if (SKIP_DELTAS && isReconstructableDelta(ev)) return;
    const env = enrichEvent(ev, kind, sessionId);
    publishNotificationRuntimeEvent(env);
    const key = logKey(kind, sessionId);
    const list = logs.get(key) ?? [];
    list.push(env);
    if (list.length > CAP_PER_SESSION) list.splice(0, list.length - CAP_PER_SESSION);
    logs.set(key, list);
    persistEvent(env);
  });
}

export function getRuntimeEventLog(kind: RuntimeLogKind, sessionId: number): RuntimeEventEnvelope[] {
  const persisted = readPersistedEvents(kind, sessionId);
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

function enrichEvent(ev: BufferedEvent, kind: RuntimeLogKind, sessionId: number): RuntimeEventEnvelope {
  const data = asRecord(ev.data);
  return {
    ...ev,
    ts: Date.now(),
    kind,
    sessionId,
    ...(typeof data.opId === 'string' ? { opId: data.opId } : {}),
    ...(typeof data.groupId === 'string' ? { groupId: data.groupId } : {}),
    ...(typeof data.agentIndex === 'number' ? { agentIndex: data.agentIndex } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function logKey(kind: RuntimeLogKind, sessionId: number): string {
  return `${kind}:${sessionId}`;
}

function eventKey(event: RuntimeEventEnvelope): string {
  return `${event.ts}:${event.seq}:${event.event}`;
}

function persistEvent(event: RuntimeEventEnvelope): void {
  const file = logFile(event.kind, event.sessionId);
  const dir = path.dirname(file);
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  }).catch(() => undefined);
  writeChains.set(file, next);
}

function readPersistedEvents(kind: RuntimeLogKind, sessionId: number): RuntimeEventEnvelope[] {
  const file = logFile(kind, sessionId);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuntimeEventEnvelope);
  } catch {
    return [];
  }
}

function logFile(kind: RuntimeLogKind, sessionId: number): string {
  return path.join(runtimeLogDir(), kind, `${sessionId}.jsonl`);
}

function runtimeLogDir(): string {
  return process.env.MCP_RUNTIME_EVENT_LOG_DIR
    ? path.resolve(process.env.MCP_RUNTIME_EVENT_LOG_DIR)
    : path.join(process.cwd(), '.mcp-indexer', 'runtime-event-logs');
}
