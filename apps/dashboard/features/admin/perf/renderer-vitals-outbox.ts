import { STORAGE_PREFIX, type QueuedRendererFreeze, type RendererFreezeReport, type LongTaskRow, type StoredSessionOutbox, MAX_EVENTS_PER_SESSION, type RendererVitalsState } from './renderer-vitals-state.js';

export function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function outboxKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function finiteNonNegative(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
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
    && (row.script === undefined || typeof row.script === 'string')
    && (row.blockingDurationMs === undefined || finiteNonNegative(row.blockingDurationMs))
    && (row.forcedStyleAndLayoutDurationMs === undefined || finiteNonNegative(row.forcedStyleAndLayoutDurationMs));
}

function emptyReport(sessionId: string, createdAt: number): RendererFreezeReport {
  return {
    sessionId,
    createdAt,
    count: 0,
    dropped: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    loafCount: 0,
    longtaskCount: 0,
    blockingDurationTotalMs: 0,
    forcedStyleAndLayoutDurationTotalMs: 0,
    firstAt: null,
    lastAt: null,
  };
}

export function addToReport(report: RendererFreezeReport, event: LongTaskRow): void {
  report.count++;
  report.totalDurationMs += event.durationMs;
  report.maxDurationMs = Math.max(report.maxDurationMs, event.durationMs);
  if (event.kind === 'loaf') report.loafCount++;
  else report.longtaskCount++;
  report.blockingDurationTotalMs += event.blockingDurationMs ?? 0;
  report.forcedStyleAndLayoutDurationTotalMs += event.forcedStyleAndLayoutDurationMs ?? 0;
  report.firstAt = report.firstAt == null ? event.at : Math.min(report.firstAt, event.at);
  report.lastAt = report.lastAt == null ? event.at : Math.max(report.lastAt, event.at);
}

export function reportFromEvents(
  sessionId: string,
  createdAt: number,
  events: QueuedRendererFreeze[],
): RendererFreezeReport {
  const report = emptyReport(sessionId, createdAt);
  for (const event of events) addToReport(report, event);
  return report;
}

function parseReport(
  value: unknown,
  sessionId: string,
  createdAt: number,
  knownEvents: QueuedRendererFreeze[],
  trimmedEvents: number,
): RendererFreezeReport {
  const fallback = reportFromEvents(sessionId, createdAt, knownEvents);
  fallback.dropped = trimmedEvents;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const row = value as Partial<RendererFreezeReport>;
  if (row.sessionId !== sessionId || !finiteNumber(row.createdAt) || row.createdAt <= 0) return fallback;
  const count = finiteNonNegative(row.count) ? Math.floor(row.count) : fallback.count;
  const dropped = finiteNonNegative(row.dropped) ? Math.floor(row.dropped) : trimmedEvents;
  return {
    sessionId,
    createdAt: row.createdAt,
    count: Math.max(count, fallback.count),
    dropped: Math.min(Math.max(dropped, trimmedEvents), Math.max(count, fallback.count)),
    totalDurationMs: finiteNonNegative(row.totalDurationMs)
      ? Math.max(row.totalDurationMs, fallback.totalDurationMs)
      : fallback.totalDurationMs,
    maxDurationMs: finiteNonNegative(row.maxDurationMs)
      ? Math.max(row.maxDurationMs, fallback.maxDurationMs)
      : fallback.maxDurationMs,
    loafCount: finiteNonNegative(row.loafCount)
      ? Math.max(Math.floor(row.loafCount), fallback.loafCount)
      : fallback.loafCount,
    longtaskCount: finiteNonNegative(row.longtaskCount)
      ? Math.max(Math.floor(row.longtaskCount), fallback.longtaskCount)
      : fallback.longtaskCount,
    blockingDurationTotalMs: finiteNonNegative(row.blockingDurationTotalMs)
      ? Math.max(row.blockingDurationTotalMs, fallback.blockingDurationTotalMs)
      : fallback.blockingDurationTotalMs,
    forcedStyleAndLayoutDurationTotalMs: finiteNonNegative(row.forcedStyleAndLayoutDurationTotalMs)
      ? Math.max(row.forcedStyleAndLayoutDurationTotalMs, fallback.forcedStyleAndLayoutDurationTotalMs)
      : fallback.forcedStyleAndLayoutDurationTotalMs,
    firstAt: finiteNumber(row.firstAt) && fallback.firstAt != null
      ? Math.min(row.firstAt, fallback.firstAt)
      : row.firstAt === null || finiteNumber(row.firstAt) ? row.firstAt : fallback.firstAt,
    lastAt: finiteNumber(row.lastAt) && fallback.lastAt != null
      ? Math.max(row.lastAt, fallback.lastAt)
      : row.lastAt === null || finiteNumber(row.lastAt) ? row.lastAt : fallback.lastAt,
  };
}

function parseOutbox(raw: string | null): StoredSessionOutbox | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSessionOutbox>;
    if (value.version !== 1 || typeof value.sessionId !== 'string' || !finiteNumber(value.createdAt)) return null;
    if (!Array.isArray(value.events)) return null;
    const allEvents = value.events.filter(isQueuedEvent);
    const events = allEvents.slice(-MAX_EVENTS_PER_SESSION);
    return {
      version: 1,
      sessionId: value.sessionId,
      createdAt: value.createdAt,
      events,
      report: parseReport(value.report, value.sessionId, value.createdAt, allEvents, allEvents.length - events.length),
    };
  } catch {
    return null;
  }
}

export function readOutbox(key: string, state: RendererVitalsState): StoredSessionOutbox | null {
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

export function writeOutbox(key: string, outbox: StoredSessionOutbox, state: RendererVitalsState): void {
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

export function removeOutbox(key: string, state: RendererVitalsState): void {
  const local = storage();
  if (local) {
    try { local.removeItem(key); } catch { /* best-effort acknowledgement */ }
  }
  state.fallbackOutboxes.delete(key);
}

export function listOutboxes(state: RendererVitalsState): Array<{ key: string; outbox: StoredSessionOutbox }> {
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
