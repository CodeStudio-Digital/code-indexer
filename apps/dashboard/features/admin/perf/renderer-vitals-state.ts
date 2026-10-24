

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
  /** LoAF main-thread blocking time, when Chromium exposes it. */
  blockingDurationMs?: number;
  /** Sum of forced style/layout work reported by the LoAF script timings. */
  forcedStyleAndLayoutDurationMs?: number;
}

export interface LoafScript {
  sourceURL?: string;
  invoker?: string;
  invokerType?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}

export interface LoafEntry extends PerformanceEntry {
  scripts?: LoafScript[];
  blockingDuration?: number;
}

export interface QueuedRendererFreeze extends LongTaskRow {
  id: string;
}

export interface StoredSessionOutbox {
  version: 1;
  sessionId: string;
  createdAt: number;
  events: QueuedRendererFreeze[];
  /** Cumulative, retry-idempotent totals for rows that may age out of `events`. */
  report?: RendererFreezeReport;
}

export interface RendererFreezeReport {
  sessionId: string;
  createdAt: number;
  count: number;
  dropped: number;
  totalDurationMs: number;
  maxDurationMs: number;
  loafCount: number;
  longtaskCount: number;
  blockingDurationTotalMs: number;
  forcedStyleAndLayoutDurationTotalMs: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface RendererVitalsState {
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
  /** One process-lifetime accumulator; survives successful outbox drains. */
  currentReport?: RendererFreezeReport;
}

export const GLOBAL_STATE_KEY = '__mcpRendererVitalsStateV2__';

export const STORAGE_PREFIX = 'mcp.renderer-vitals.outbox.v1:';

export const POST_URL = '/api/admin/perf/renderer-freezes';

export const MAX_ROWS = 50;

export const MAX_SEEN_IDS = 500;

export const MAX_EVENTS_PER_SESSION = 120;

export const BATCH_SIZE = 50;

export const INITIAL_FLUSH_DELAY_MS = 1_000;

export const INITIAL_RETRY_MS = 1_000;

export const MAX_RETRY_MS = 30_000;

type StateHost = typeof globalThis & {
  [GLOBAL_STATE_KEY]?: RendererVitalsState;
};

export function stateHost(): StateHost {
  return globalThis as StateHost;
}

export function existingState(): RendererVitalsState | undefined {
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

export function getState(): RendererVitalsState {
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
