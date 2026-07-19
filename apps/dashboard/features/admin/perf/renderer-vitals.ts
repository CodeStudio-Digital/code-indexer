/**
 * Process-lifetime renderer freeze collector.
 *
 * Freeze rows are written to a bounded localStorage outbox before any network
 * request. A force-killed renderer therefore leaves its session queue for the
 * next launch to retry. Event ids are deterministic within a renderer session,
 * so a response lost after a successful POST can be retried safely.
 */

export interface LongTaskRow {
  at: number;
  durationMs: number;
  /** Human label: the dominant script's invoker/url (LoAF) or entry name (longtask). */
  name: string;
  /** LoAF only: the blocking script's source URL. */
  script?: string;
  kind: 'loaf' | 'longtask';
}

interface LoafScript {
  sourceURL?: string;
  invoker?: string;
  invokerType?: string;
  duration: number;
}

interface LoafEntry extends PerformanceEntry {
  scripts?: LoafScript[];
}

interface QueuedRendererFreeze extends LongTaskRow {
  id: string;
}

interface StoredSessionOutbox {
  version: 1;
  sessionId: string;
  createdAt: number;
  events: QueuedRendererFreeze[];
}

interface RendererVitalsState {
  sessionId: string;
  started: boolean;
  observer?: PerformanceObserver;
  rows: LongTaskRow[];
  seenIds: Set<string>;
  seenOrder: string[];
  flushTimer?: ReturnType<typeof setTimeout>;
  flushing: boolean;
  retryMs: number;
  pagehideHandler?: () => void;
  fallbackOutboxes: Map<string, StoredSessionOutbox>;
}

const GLOBAL_STATE_KEY = '__mcpRendererVitalsStateV2__';
const STORAGE_PREFIX = 'mcp.renderer-vitals.outbox.v1:';
const POST_URL = '/api/admin/perf/renderer-freezes';
const MAX_ROWS = 50;
const MAX_SEEN_IDS = 500;
const MAX_EVENTS_PER_SESSION = 120;
const BATCH_SIZE = 50;
const INITIAL_FLUSH_DELAY_MS = 1_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

type StateHost = typeof globalThis & {
  [GLOBAL_STATE_KEY]?: RendererVitalsState;
};

function stateHost(): StateHost {
  return globalThis as StateHost;
}

function existingState(): RendererVitalsState | undefined {
  return stateHost()[GLOBAL_STATE_KEY];
}

function newSessionId(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  } catch {
    // The timestamp/random fallback is sufficient to separate renderer documents.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getState(): RendererVitalsState {
  const host = stateHost();
  if (!host[GLOBAL_STATE_KEY]) {
    host[GLOBAL_STATE_KEY] = {
      sessionId: newSessionId(),
      started: false,
      rows: [],
      seenIds: new Set(),
      seenOrder: [],
      flushing: false,
      retryMs: INITIAL_RETRY_MS,
      fallbackOutboxes: new Map(),
    };
  }
  return host[GLOBAL_STATE_KEY];
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function outboxKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isQueuedEvent(value: unknown): value is QueuedRendererFreeze {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<QueuedRendererFreeze>;
  return typeof row.id === 'string'
    && row.id.length > 0
    && finiteNumber(row.at)
    && finiteNumber(row.durationMs)
    && typeof row.name === 'string'
    && (row.kind === 'loaf' || row.kind === 'longtask')
    && (row.script === undefined || typeof row.script === 'string');
}

function parseOutbox(raw: string | null): StoredSessionOutbox | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSessionOutbox>;
    if (value.version !== 1 || typeof value.sessionId !== 'string' || !finiteNumber(value.createdAt)) return null;
    if (!Array.isArray(value.events)) return null;
    return {
      version: 1,
      sessionId: value.sessionId,
      createdAt: value.createdAt,
      events: value.events.filter(isQueuedEvent).slice(-MAX_EVENTS_PER_SESSION),
    };
  } catch {
    return null;
  }
}

function readOutbox(key: string, state: RendererVitalsState): StoredSessionOutbox | null {
  const local = storage();
  if (local) {
    try {
      const parsed = parseOutbox(local.getItem(key));
      if (parsed) return parsed;
    } catch {
      // Fall through to the in-memory queue when storage is unavailable/full.
    }
  }
  return state.fallbackOutboxes.get(key) ?? null;
}

function writeOutbox(key: string, outbox: StoredSessionOutbox, state: RendererVitalsState): void {
  const local = storage();
  if (local) {
    try {
      local.setItem(key, JSON.stringify(outbox));
      state.fallbackOutboxes.delete(key);
      return;
    } catch {
      // Preserve collection in memory even when localStorage rejects the write.
    }
  }
  state.fallbackOutboxes.set(key, outbox);
}

function removeOutbox(key: string, state: RendererVitalsState): void {
  const local = storage();
  if (local) {
    try { local.removeItem(key); } catch { /* best-effort acknowledgement */ }
  }
  state.fallbackOutboxes.delete(key);
}

function listOutboxes(state: RendererVitalsState): Array<{ key: string; outbox: StoredSessionOutbox }> {
  const found = new Map<string, StoredSessionOutbox>();
  const local = storage();
  if (local) {
    try {
      for (let i = 0; i < local.length; i++) {
        const key = local.key(i);
        if (!key?.startsWith(STORAGE_PREFIX)) continue;
        const parsed = parseOutbox(local.getItem(key));
        if (parsed?.events.length) found.set(key, parsed);
      }
    } catch {
      // Entries already found remain usable; memory fallbacks are merged below.
    }
  }
  for (const [key, outbox] of state.fallbackOutboxes) {
    if (outbox.events.length && !found.has(key)) found.set(key, outbox);
  }
  return [...found.entries()]
    .map(([key, outbox]) => ({ key, outbox }))
    .sort((a, b) => a.outbox.createdAt - b.outbox.createdAt);
}

function sanitizeText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizeScript(value: string | undefined): string | undefined {
  const text = sanitizeText(value, 4_000);
  if (!text) return undefined;
  const query = text.search(/[?#]/);
  return (query >= 0 ? text.slice(0, query) : text).slice(0, 4_000) || undefined;
}

/** Convert a monotonic PerformanceEntry timestamp into Unix epoch milliseconds. */
export function rendererEntryEpochMs(entry: Pick<PerformanceEntry, 'startTime'>, timeOrigin?: number): number {
  const origin = timeOrigin
    ?? (typeof performance !== 'undefined' && finiteNumber(performance.timeOrigin)
      ? performance.timeOrigin
      : Date.now());
  const startTime = finiteNumber(entry.startTime) ? entry.startTime : 0;
  return Math.round(origin + startTime);
}

/** Map a LoAF entry to the compact row shared by the live panel and journal. */
export function loafToRow(e: LoafEntry, at = rendererEntryEpochMs(e)): LongTaskRow {
  let top: LoafScript | undefined;
  for (const script of e.scripts ?? []) {
    if (!top || script.duration > top.duration) top = script;
  }
  const script = sanitizeScript(top?.sourceURL);
  return {
    at,
    durationMs: Math.round(e.duration),
    name: sanitizeText(top?.invoker, 2_000) || script || sanitizeText(e.name, 2_000) || 'animation-frame',
    script,
    kind: 'loaf',
  };
}

function longTaskToRow(entry: PerformanceEntry): LongTaskRow {
  return {
    at: rendererEntryEpochMs(entry),
    durationMs: Math.round(entry.duration),
    name: sanitizeText(entry.name, 2_000) || 'longtask',
    kind: 'longtask',
  };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function eventId(sessionId: string, entry: PerformanceEntry, row: LongTaskRow): string {
  const startUs = Math.round((finiteNumber(entry.startTime) ? entry.startTime : 0) * 1_000).toString(36);
  const durationUs = Math.round((finiteNumber(entry.duration) ? entry.duration : 0) * 1_000).toString(36);
  const signature = stableHash(`${row.name}\n${row.script ?? ''}`);
  return `rv1:${sessionId}:${row.kind}:${startUs}:${durationUs}:${signature}`;
}

function rememberId(state: RendererVitalsState, id: string): boolean {
  if (state.seenIds.has(id)) return false;
  state.seenIds.add(id);
  state.seenOrder.push(id);
  if (state.seenOrder.length > MAX_SEEN_IDS) {
    const removed = state.seenOrder.splice(0, state.seenOrder.length - MAX_SEEN_IDS);
    for (const oldId of removed) state.seenIds.delete(oldId);
  }
  return true;
}

function enqueue(state: RendererVitalsState, event: QueuedRendererFreeze): void {
  const key = outboxKey(state.sessionId);
  const outbox = readOutbox(key, state) ?? {
    version: 1,
    sessionId: state.sessionId,
    createdAt: Date.now(),
    events: [],
  };
  if (outbox.events.some((queued) => queued.id === event.id)) return;
  outbox.events.push(event);
  if (outbox.events.length > MAX_EVENTS_PER_SESSION) {
    outbox.events.splice(0, outbox.events.length - MAX_EVENTS_PER_SESSION);
  }
  writeOutbox(key, outbox, state);
}

function captureEntry(state: RendererVitalsState, entry: PerformanceEntry, row: LongTaskRow): void {
  const id = eventId(state.sessionId, entry, row);
  if (!rememberId(state, id)) return;
  state.rows.push(row);
  if (state.rows.length > MAX_ROWS) state.rows.splice(0, state.rows.length - MAX_ROWS);
  enqueue(state, { id, ...row });
  scheduleFlush(state, INITIAL_FLUSH_DELAY_MS);
}

function acknowledge(key: string, ids: Set<string>, state: RendererVitalsState): void {
  // Re-read immediately before acknowledgement so events captured while the
  // request was in flight are never removed with the completed batch.
  const latest = readOutbox(key, state);
  if (!latest) return;
  latest.events = latest.events.filter((event) => !ids.has(event.id));
  if (latest.events.length) writeOutbox(key, latest, state);
  else removeOutbox(key, state);
}

function scheduleFlush(state: RendererVitalsState, delayMs: number): void {
  if (state.flushTimer !== undefined || typeof fetch !== 'function') return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = undefined;
    void flushOutboxes(state, false);
  }, Math.max(0, delayMs));
}

async function flushOutboxes(state: RendererVitalsState, keepalive: boolean): Promise<void> {
  if (state.flushing || typeof fetch !== 'function') return;
  const next = listOutboxes(state)[0];
  if (!next) return;

  const batch = next.outbox.events.slice(0, BATCH_SIZE);
  const ids = new Set(batch.map((event) => event.id));
  state.flushing = true;
  try {
    const response = await fetch(POST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Deliberately omit runId: recovered queues belong to the run selected by
      // each event's epoch timestamp, never automatically to the current boot.
      body: JSON.stringify({ events: batch }),
      keepalive,
    });
    if (!response.ok) throw new Error(`renderer freeze upload failed: HTTP ${response.status}`);
    const result = await response.json() as { accepted?: unknown };
    if (result.accepted !== batch.length) throw new Error('renderer freeze upload was only partially accepted');
    acknowledge(next.key, ids, state);
    state.retryMs = INITIAL_RETRY_MS;
    if (listOutboxes(state).length) scheduleFlush(state, 0);
  } catch {
    const retryMs = state.retryMs;
    state.retryMs = Math.min(MAX_RETRY_MS, Math.max(INITIAL_RETRY_MS, retryMs * 2));
    scheduleFlush(state, retryMs);
  } finally {
    state.flushing = false;
  }
}

function startObserver(state: RendererVitalsState): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes;
  const useLoaf = Array.isArray(supported) && supported.includes('long-animation-frame');

  if (useLoaf) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const loaf = entry as LoafEntry;
          captureEntry(state, loaf, loafToRow(loaf));
        }
      });
      observer.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
      state.observer = observer;
      return;
    } catch {
      // Fall through to legacy longtask collection.
    }
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) captureEntry(state, entry, longTaskToRow(entry));
    });
    try {
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    } catch {
      observer.observe({ entryTypes: ['longtask'] });
    }
    state.observer = observer;
  } catch {
    // Neither API is supported. Recovery uploads still run below.
  }
}

/** Start once for the renderer process. Safe across React remounts and Vite HMR. */
export function ensureRendererVitals(): void {
  const state = getState();
  if (!state.started) {
    state.started = true;
    startObserver(state);
    if (typeof window !== 'undefined') {
      state.pagehideHandler = () => { void flushOutboxes(state, true); };
      window.addEventListener('pagehide', state.pagehideHandler);
    }
  }
  // Also drains queues left by a renderer that was force-killed before POST.
  scheduleFlush(state, 0);
}

/**
 * Compatibility no-op for the admin panel cleanup. Collection is global and
 * must not stop merely because the Performance screen was unmounted.
 */
export function stopRendererVitals(): void {
  const state = existingState();
  if (state) scheduleFlush(state, 0);
}

export function getLongTasks(): LongTaskRow[] {
  return [...(existingState()?.rows ?? [])].reverse();
}

/** Clear only the live panel ring; persisted/retry diagnostics remain intact. */
export function clearLongTasks(): void {
  const state = existingState();
  if (state) state.rows.length = 0;
}

/** Test-only deterministic drain hook. */
export async function __flushRendererVitalsForTests(): Promise<void> {
  const state = getState();
  if (state.flushTimer !== undefined) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
  await flushOutboxes(state, false);
}

/** Test-only singleton teardown; storage can be preserved to simulate a crash/relaunch. */
export function __resetRendererVitalsForTests(options: { preserveStorage?: boolean } = {}): void {
  const state = existingState();
  if (state?.flushTimer !== undefined) clearTimeout(state.flushTimer);
  try { state?.observer?.disconnect(); } catch { /* best-effort test cleanup */ }
  if (state?.pagehideHandler && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', state.pagehideHandler);
  }
  if (!options.preserveStorage) {
    const local = storage();
    if (local) {
      try {
        const keys: string[] = [];
        for (let i = 0; i < local.length; i++) {
          const key = local.key(i);
          if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
        }
        for (const key of keys) local.removeItem(key);
      } catch { /* best-effort test cleanup */ }
    }
  }
  delete stateHost()[GLOBAL_STATE_KEY];
}
