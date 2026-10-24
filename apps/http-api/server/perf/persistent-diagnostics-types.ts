import type { PerfSample } from './perf-sampler-types.js';

export interface PersistedFreezeEvent {
  at: number;
  source:
    | 'handler'
    | 'background'
    | 'event-loop'
    | 'renderer'
    | 'starved'
    | 'offloop'
    | 'gc'
    | 'sync'
    | 'unattributed';
  channel?: string;
  durationMs: number;
  detail?: string;
  count?: number;
  wallLateMs?: number;
  windowMs?: number;
  /** `null` where the runtime cannot report loop utilization (Electron main). */
  activeMs?: number | null;
  busyFraction?: number | null;
  /** Measured synchronous main-thread ms in the window. */
  busyMs?: number;
  /** V8 GC pause ms overlapping the window. */
  gcMs?: number;
  topSyncLabel?: string;
  eluAvailable?: boolean;
  coverage?: 'observed' | 'silent';
  /** Main-process RSS at detection, and the delta vs the last healthy tick. */
  rssMB?: number;
  rssDeltaMB?: number;
  /**
   * `offloop` only. Rows sharing a `hangId` describe ONE ongoing stall and must
   * be collapsed with `max(durationMs)` — summing over-counts roughly 2×.
   */
  hangId?: string;
  reportSeq?: number;
  suspects?: Array<{ channel: string; startedAt: number; kind?: 'handler' | 'background' }>;
  detectedBy?: 'worker-thread';
}

export interface PersistedRendererFreeze {
  id: string;
  at: number;
  durationMs: number;
  name: string;
  script?: string;
  kind: 'loaf' | 'longtask';
  blockingDurationMs?: number;
  forcedStyleAndLayoutDurationMs?: number;
  /** Original run aged out before the renderer could retry its outbox. */
  recoveredToCurrent?: boolean;
}

/** Cumulative renderer-session totals. Re-sending a newer snapshot is safe. */
export interface PersistedRendererFreezeReport {
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

export interface PersistedRendererFreezeSummary {
  /** Total observed by renderers, including rows that could not be retained. */
  count: number;
  /** Unique renderer rows found in the journal files read for this detail. */
  persisted: number;
  /** Rows returned in `rendererFreezes` (bounded for API/UI safety). */
  retained: number;
  /** Rows omitted either by the renderer outbox or detail retention. */
  dropped: number;
  droppedBeforePersist: number;
  droppedFromDetail: number;
  /** Observed rows not represented by a persisted row or a declared outbox drop. */
  unavailable: number;
  totalDurationMs: number;
  maxDurationMs: number;
  loafCount: number;
  longtaskCount: number;
  blockingDurationTotalMs: number;
  forcedStyleAndLayoutDurationTotalMs: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface PersistedPerfReadMetadata {
  /** Server-side snapshot boundary used by the downloaded export. */
  cutoffAt: number;
  dataThroughAt: number | null;
  complete: boolean;
  reasons: string[];
  filesAvailable: number;
  filesRead: number;
  bytesRead: number;
}

export interface PersistedSlowCall {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface PersistedPerfRunSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: 'current' | 'closed' | 'interrupted';
  pid: number;
  sizeBytes: number;
  path: string;
  nodeVersion?: string;
  electronVersion?: string;
}

export interface PersistedPerfRunDetail {
  run: PersistedPerfRunSummary;
  samples: PerfSample[];
  freezes: PersistedFreezeEvent[];
  rendererFreezes: PersistedRendererFreeze[];
  rendererFreezeSummary: PersistedRendererFreezeSummary;
  slowCalls: PersistedSlowCall[];
  recordsRead: number;
  corruptLines: number;
  read: PersistedPerfReadMetadata;
}

export interface RunManifest {
  schemaVersion: number;
  id: string;
  startedAt: number;
  pid: number;
  nodeVersion?: string;
  electronVersion?: string;
  platform: NodeJS.Platform;
  arch: string;
}

export type JournalRecord =
  | { type: 'segment_start'; at: number; runId: string; segment: number; schemaVersion: number }
  | { type: 'sample'; at: number; sample: PerfSample; host: { freeMemoryMB: number; totalMemoryMB: number } }
  | { type: 'freeze'; at: number; event: PersistedFreezeEvent }
  | { type: 'renderer_freeze'; at: number; event: PersistedRendererFreeze }
  | { type: 'renderer_freeze_report'; at: number; report: PersistedRendererFreezeReport }
  | { type: 'slow_call'; at: number; channel: string; durationMs: number }
  | { type: 'run_end'; at: number; reason: string };

export interface PersistentPerfDiagnosticsOptions {
  rootDir?: string;
  now?: () => number;
  pid?: number;
  runId?: string;
  segmentBytes?: number;
  maxSegments?: number;
  maxRuns?: number;
  /** Test seam; production uses the partial-write-safe libuv writer. */
  writeBuffer?: (fd: number, buffer: Buffer) => void | Promise<void>;
}
