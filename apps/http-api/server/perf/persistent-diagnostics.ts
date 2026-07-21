/**
 * Crash-resilient performance journal.
 *
 * Each app run owns a small directory under the canonical MCP data directory.
 * Critical records are appended as JSONL through a serialized asynchronous
 * writer. Filesystem/filter-driver stalls therefore cannot park Electron's
 * main event loop. The independent off-loop watchdog remains the durable path
 * for freezes observed while this queue is delayed. Low-priority slow call
 * rows are coalesced for one event-loop turn before using the same writer.
 * Readers deliberately ignore a malformed tail. A `closed.json` marker is
 * written only on a clean shutdown; its absence lets the next run label the
 * session as interrupted.
 */
import {
  close as closeCallback,
  closeSync,
  existsSync,
  fdatasync as fdatasyncCallback,
  fdatasyncSync,
  mkdirSync,
  open as openCallback,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  write as writeCallback,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';
import {
  appendFile as appendFileAsync,
  open as openAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rename as renameAsync,
  stat as statAsync,
  unlink as unlinkAsync,
} from 'node:fs/promises';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { PerfSample } from './perf-sampler.js';

const SCHEMA_VERSION = 1;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 4;
const DEFAULT_MAX_RUNS = 8;
const SAMPLE_LIMIT = 240;
const FREEZE_LIMIT = 240;
const RENDERER_LIMIT = 120;
const SLOW_SAMPLE_CAP = 128;
const MAX_SLOW_CHANNELS = 200;
const ASYNC_READ_FILE_BYTES = 4 * 1024 * 1024;
const ASYNC_READ_RUN_BYTES = 32 * 1024 * 1024;
const ASYNC_PARSE_YIELD_LINES = 250;

export interface PersistedFreezeEvent {
  at: number;
  source: 'handler' | 'background' | 'event-loop' | 'renderer' | 'starved' | 'offloop';
  channel?: string;
  durationMs: number;
  detail?: string;
  count?: number;
  wallLateMs?: number;
  windowMs?: number;
  activeMs?: number;
  busyFraction?: number;
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

interface RunManifest {
  schemaVersion: number;
  id: string;
  startedAt: number;
  pid: number;
  nodeVersion?: string;
  electronVersion?: string;
  platform: NodeJS.Platform;
  arch: string;
}

type JournalRecord =
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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function safeTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function boundedPush<T>(rows: T[], value: T, limit: number): void {
  rows.push(value);
  if (rows.length > limit) rows.splice(0, rows.length - limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function writeFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(fd, buffer, offset, buffer.byteLength - offset, null);
    if (written <= 0) throw new Error('diagnostics write made no progress');
    offset += written;
  }
}

function writeFullyAsync(fd: number, buffer: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let offset = 0;
    const next = (): void => {
      if (offset >= buffer.byteLength) {
        resolveWrite();
        return;
      }
      writeCallback(fd, buffer, offset, buffer.byteLength - offset, null, (error, written) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        if (written <= 0) {
          rejectWrite(new Error('diagnostics write made no progress'));
          return;
        }
        offset += written;
        next();
      });
    };
    next();
  });
}

function openFdAsync(path: string): Promise<number> {
  return new Promise((resolveOpen, rejectOpen) => {
    openCallback(path, 'a', 0o600, (error, fd) => error ? rejectOpen(error) : resolveOpen(fd));
  });
}

function closeFdAsync(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    closeCallback(fd, (error) => error ? rejectClose(error) : resolveClose());
  });
}

function syncFdAsync(fd: number): Promise<void> {
  return new Promise((resolveSync, rejectSync) => {
    fdatasyncCallback(fd, (error) => error ? rejectSync(error) : resolveSync());
  });
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFully(fd, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(temporary); } catch { /* ignore */ }
    throw error;
  }
}

async function writeJsonAtomicAsync(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof openAsync>> | null = null;
  try {
    file = await openAsync(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await renameAsync(temporary, path);
  } catch (error) {
    if (file) {
      try { await file.close(); } catch { /* ignore */ }
    }
    try { await unlinkAsync(temporary); } catch { /* ignore */ }
    throw error;
  }
}

async function readJsonAsync(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFileAsync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function manifestFrom(path: string): RunManifest | null {
  const value = readJson(path);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== 'string') return null;
  if (typeof value.startedAt !== 'number' || typeof value.pid !== 'number') return null;
  return value as unknown as RunManifest;
}

type SlowAccumulator = Map<string, {
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  samples: number[];
}>;

interface RendererAccumulator {
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

interface ReadAccumulator {
  cutoffAt: number;
  dataThroughAt: number | null;
  filesAvailable: number;
  filesRead: number;
  bytesRead: number;
  reasons: Set<string>;
}

const LEGACY_RENDERER_SESSION = '__legacy__';

function emptyRendererAccumulator(): RendererAccumulator {
  return {
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

function rendererSessionFromId(id: string): string {
  if (!id.startsWith('rv1:')) return LEGACY_RENDERER_SESSION;
  const separator = id.indexOf(':', 4);
  return separator > 4 ? id.slice(4, separator) : LEGACY_RENDERER_SESSION;
}

function addRendererEvent(acc: RendererAccumulator, event: PersistedRendererFreeze): void {
  acc.count++;
  acc.totalDurationMs += Number.isFinite(event.durationMs) ? event.durationMs : 0;
  acc.maxDurationMs = Math.max(acc.maxDurationMs, Number.isFinite(event.durationMs) ? event.durationMs : 0);
  if (event.kind === 'loaf') acc.loafCount++;
  else if (event.kind === 'longtask') acc.longtaskCount++;
  acc.blockingDurationTotalMs += Number.isFinite(event.blockingDurationMs) ? event.blockingDurationMs! : 0;
  acc.forcedStyleAndLayoutDurationTotalMs += Number.isFinite(event.forcedStyleAndLayoutDurationMs)
    ? event.forcedStyleAndLayoutDurationMs!
    : 0;
  if (Number.isFinite(event.at)) {
    acc.firstAt = acc.firstAt == null ? event.at : Math.min(acc.firstAt, event.at);
    acc.lastAt = acc.lastAt == null ? event.at : Math.max(acc.lastAt, event.at);
  }
}

function rendererAccumulatorFromReport(report: PersistedRendererFreezeReport): RendererAccumulator {
  return {
    count: report.count,
    dropped: Math.min(report.count, report.dropped),
    totalDurationMs: report.totalDurationMs,
    maxDurationMs: report.maxDurationMs,
    loafCount: report.loafCount,
    longtaskCount: report.longtaskCount,
    blockingDurationTotalMs: report.blockingDurationTotalMs,
    forcedStyleAndLayoutDurationTotalMs: report.forcedStyleAndLayoutDurationTotalMs,
    firstAt: report.firstAt,
    lastAt: report.lastAt,
  };
}

function mergeRendererAccumulator(target: RendererAccumulator, source: RendererAccumulator): void {
  target.count += source.count;
  target.dropped += source.dropped;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
  target.loafCount += source.loafCount;
  target.longtaskCount += source.longtaskCount;
  target.blockingDurationTotalMs += source.blockingDurationTotalMs;
  target.forcedStyleAndLayoutDurationTotalMs += source.forcedStyleAndLayoutDurationTotalMs;
  if (source.firstAt != null) target.firstAt = target.firstAt == null
    ? source.firstAt
    : Math.min(target.firstAt, source.firstAt);
  if (source.lastAt != null) target.lastAt = target.lastAt == null
    ? source.lastAt
    : Math.max(target.lastAt, source.lastAt);
}

function validRendererReport(value: unknown): value is PersistedRendererFreezeReport {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false;
  const numeric = [
    value.createdAt,
    value.count,
    value.dropped,
    value.totalDurationMs,
    value.maxDurationMs,
    value.loafCount,
    value.longtaskCount,
    value.blockingDurationTotalMs,
    value.forcedStyleAndLayoutDurationTotalMs,
  ];
  return numeric.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
    && (value.firstAt === null || (typeof value.firstAt === 'number' && Number.isFinite(value.firstAt)))
    && (value.lastAt === null || (typeof value.lastAt === 'number' && Number.isFinite(value.lastAt)));
}

interface RunAccumulator {
  run: PersistedPerfRunSummary;
  samples: PerfSample[];
  freezes: PersistedFreezeEvent[];
  rendererFreezes: PersistedRendererFreeze[];
  rendererIds: Set<string>;
  rendererBySession: Map<string, RendererAccumulator>;
  rendererReports: Map<string, PersistedRendererFreezeReport>;
  slow: SlowAccumulator;
  recordsRead: number;
  corruptLines: number;
  read: ReadAccumulator;
}

function newRunAccumulator(run: PersistedPerfRunSummary, cutoffAt: number): RunAccumulator {
  return {
    run,
    samples: [],
    freezes: [],
    rendererFreezes: [],
    rendererIds: new Set(),
    rendererBySession: new Map(),
    rendererReports: new Map(),
    slow: new Map(),
    recordsRead: 0,
    corruptLines: 0,
    read: {
      cutoffAt,
      dataThroughAt: null,
      filesAvailable: 0,
      filesRead: 0,
      bytesRead: 0,
      reasons: new Set(),
    },
  };
}

function consumeJournalLine(acc: RunAccumulator, line: string): void {
  if (!line.trim()) return;
  let record: unknown;
  try { record = JSON.parse(line) as unknown; } catch { acc.corruptLines++; return; }
  if (!isRecord(record) || typeof record.type !== 'string') { acc.corruptLines++; return; }
  if (typeof record.at === 'number' && Number.isFinite(record.at) && record.at > acc.read.cutoffAt) return;
  acc.recordsRead++;
  if (typeof record.at === 'number' && Number.isFinite(record.at) && record.at <= acc.read.cutoffAt) {
    acc.read.dataThroughAt = acc.read.dataThroughAt == null
      ? record.at
      : Math.max(acc.read.dataThroughAt, record.at);
  }
  if (record.type === 'sample' && isRecord(record.sample)) {
    boundedPush(acc.samples, record.sample as unknown as PerfSample, SAMPLE_LIMIT);
  } else if (record.type === 'freeze' && isRecord(record.event)) {
    boundedPush(acc.freezes, record.event as unknown as PersistedFreezeEvent, FREEZE_LIMIT);
  } else if (record.type === 'renderer_freeze' && isRecord(record.event)) {
    const event = record.event as unknown as PersistedRendererFreeze;
    if (typeof event.id === 'string' && !acc.rendererIds.has(event.id)) {
      acc.rendererIds.add(event.id);
      const sessionId = rendererSessionFromId(event.id);
      const rendererAcc = acc.rendererBySession.get(sessionId) ?? emptyRendererAccumulator();
      acc.rendererBySession.set(sessionId, rendererAcc);
      addRendererEvent(rendererAcc, event);
      boundedPush(acc.rendererFreezes, event, RENDERER_LIMIT);
    }
  } else if (record.type === 'renderer_freeze_report' && validRendererReport(record.report)) {
    const previous = acc.rendererReports.get(record.report.sessionId);
    if (!previous || record.report.count > previous.count || (
      record.report.count === previous.count && record.report.lastAt != null
      && (previous.lastAt == null || record.report.lastAt > previous.lastAt)
    )) {
      acc.rendererReports.set(record.report.sessionId, record.report);
    }
  } else if (
    record.type === 'slow_call'
    && typeof record.channel === 'string'
    && typeof record.durationMs === 'number'
    && typeof record.at === 'number'
  ) {
    let row = acc.slow.get(record.channel);
    if (!row) {
      if (acc.slow.size >= MAX_SLOW_CHANNELS) return;
      row = { count: 0, totalMs: 0, maxMs: 0, lastAt: 0, samples: [] };
      acc.slow.set(record.channel, row);
    }
    const ms = Math.round(record.durationMs);
    row.count++;
    row.totalMs += ms;
    row.maxMs = Math.max(row.maxMs, ms);
    row.lastAt = Math.max(row.lastAt, record.at);
    boundedPush(row.samples, ms, SLOW_SAMPLE_CAP);
  }
}

function finishRunAccumulator(acc: RunAccumulator): PersistedPerfRunDetail {
  const slowCalls = Array.from(acc.slow.entries())
    .map(([channel, row]): PersistedSlowCall => {
      const sorted = [...row.samples].sort((a, b) => a - b);
      return {
        channel,
        count: row.count,
        totalMs: row.totalMs,
        maxMs: row.maxMs,
        lastAt: row.lastAt,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 50);
  acc.samples.sort((a, b) => a.at - b.at);
  acc.freezes.sort((a, b) => a.at - b.at);
  acc.rendererFreezes.sort((a, b) => a.at - b.at);
  const combinedRenderer = emptyRendererAccumulator();
  let persistedRendererCount = 0;
  for (const [sessionId, eventAcc] of acc.rendererBySession) {
    persistedRendererCount += eventAcc.count;
    const report = acc.rendererReports.get(sessionId);
    mergeRendererAccumulator(
      combinedRenderer,
      report && report.count >= eventAcc.count ? rendererAccumulatorFromReport(report) : eventAcc,
    );
  }
  for (const [sessionId, report] of acc.rendererReports) {
    if (!acc.rendererBySession.has(sessionId)) {
      mergeRendererAccumulator(combinedRenderer, rendererAccumulatorFromReport(report));
    }
  }
  const retainedRendererCount = acc.rendererFreezes.length;
  const droppedFromDetail = Math.max(0, persistedRendererCount - retainedRendererCount);
  const observedRendererCount = Math.max(combinedRenderer.count, persistedRendererCount);
  // A response can be lost after persistence. In that case an outbox row may
  // later age out and be reported as dropped even though its id exists in the
  // journal; reconcile cumulative reports against the unique persisted ids.
  const droppedBeforePersist = Math.min(
    combinedRenderer.dropped,
    Math.max(0, observedRendererCount - persistedRendererCount),
  );
  const unavailable = Math.max(0, observedRendererCount - persistedRendererCount - droppedBeforePersist);
  if (unavailable > 0) acc.read.reasons.add('renderer-events-unavailable');
  if (acc.corruptLines > 0) acc.read.reasons.add('corrupt-lines');
  const reasons = [...acc.read.reasons].sort();
  return {
    run: acc.run,
    samples: acc.samples,
    freezes: acc.freezes,
    rendererFreezes: acc.rendererFreezes,
    rendererFreezeSummary: {
      count: observedRendererCount,
      persisted: persistedRendererCount,
      retained: retainedRendererCount,
      dropped: droppedBeforePersist + droppedFromDetail,
      droppedBeforePersist,
      droppedFromDetail,
      unavailable,
      totalDurationMs: Math.round(combinedRenderer.totalDurationMs * 10) / 10,
      maxDurationMs: Math.round(combinedRenderer.maxDurationMs * 10) / 10,
      loafCount: combinedRenderer.loafCount,
      longtaskCount: combinedRenderer.longtaskCount,
      blockingDurationTotalMs: Math.round(combinedRenderer.blockingDurationTotalMs * 10) / 10,
      forcedStyleAndLayoutDurationTotalMs:
        Math.round(combinedRenderer.forcedStyleAndLayoutDurationTotalMs * 10) / 10,
      firstAt: combinedRenderer.firstAt,
      lastAt: combinedRenderer.lastAt,
    },
    slowCalls,
    recordsRead: acc.recordsRead,
    corruptLines: acc.corruptLines,
    read: {
      cutoffAt: acc.read.cutoffAt,
      dataThroughAt: acc.read.dataThroughAt,
      complete: reasons.length === 0,
      reasons,
      filesAvailable: acc.read.filesAvailable,
      filesRead: acc.read.filesRead,
      bytesRead: acc.read.bytesRead,
    },
  };
}

async function readFileTail(path: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  const file = await openAsync(path, 'r');
  try {
    const stat = await file.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const position = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, position);
    let text = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (position > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return { text, bytesRead: result.bytesRead, truncated: position > 0 };
  } finally {
    await file.close();
  }
}

function boundedReadOrder(names: string[]): string[] {
  const eventFiles = names
    .filter((name) => /^events-\d+\.jsonl$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
  const specialFiles = names
    .filter((name) => name.endsWith('.jsonl') && !/^events-\d+\.jsonl$/.test(name))
    .sort();
  const slots = Math.floor(ASYNC_READ_RUN_BYTES / ASYNC_READ_FILE_BYTES);
  const keptSpecialFiles = specialFiles.slice(-Math.max(0, slots - 1));
  const eventSlots = Math.max(1, slots - keptSpecialFiles.length);
  return [...eventFiles.slice(-eventSlots), ...keptSpecialFiles];
}

function noteReadInventory(acc: RunAccumulator, names: string[], selected: string[]): void {
  const available = names.filter((name) => name.endsWith('.jsonl'));
  acc.read.filesAvailable = available.length;
  if (selected.length < available.length) acc.read.reasons.add('file-limit');

  for (const pattern of [/^events-(\d+)\.jsonl$/, /^renderer-recovered-(\d+)\.jsonl$/]) {
    const indices = available
      .map((name) => pattern.exec(name))
      .filter((match): match is RegExpExecArray => !!match)
      .map((match) => Number(match[1]));
    if (indices.length > 0 && Math.min(...indices) > 0) acc.read.reasons.add('segment-retention');
  }
}

export class PersistentPerfDiagnostics {
  readonly rootDir: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly runDir: string;

  private readonly now: () => number;
  private readonly pid: number;
  private readonly segmentBytes: number;
  private readonly maxSegments: number;
  private readonly maxRuns: number;
  private readonly writeBuffer: (fd: number, buffer: Buffer) => void | Promise<void>;
  private segment = 0;
  private segmentSize = 0;
  private currentSizeBytes = 0;
  private fd: number | null = null;
  private closed = false;
  private warned = false;
  private writeTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private rendererTail: Promise<void> = Promise.resolve();
  private readonly rendererIdsByRun = new Map<string, Set<string>>();
  private readonly recoveredSegmentByRun = new Map<string, { segment: number; size: number }>();
  private pendingSlowCalls: JournalRecord[] = [];
  private slowCallFlush: ReturnType<typeof setImmediate> | null = null;

  constructor(options: PersistentPerfDiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.startedAt = this.now();
    this.runId = options.runId ?? randomUUID();
    this.rootDir = resolve(options.rootDir ?? join(mcpDataDir(), 'perf-diagnostics'));
    this.segmentBytes = options.segmentBytes
      ?? positiveInt(process.env.MCP_PERF_LOG_SEGMENT_MB, DEFAULT_SEGMENT_BYTES / (1024 * 1024)) * 1024 * 1024;
    this.maxSegments = options.maxSegments
      ?? positiveInt(process.env.MCP_PERF_LOG_SEGMENTS, DEFAULT_MAX_SEGMENTS);
    this.maxRuns = options.maxRuns
      ?? positiveInt(process.env.MCP_PERF_LOG_RUNS, DEFAULT_MAX_RUNS);
    this.writeBuffer = options.writeBuffer ?? writeFullyAsync;

    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    this.pruneOldRuns(Math.max(0, this.maxRuns - 1));
    const dirName = `${safeTimestamp(this.startedAt)}_pid-${this.pid}_${this.runId}`;
    this.runDir = join(this.rootDir, dirName);
    mkdirSync(this.runDir, { recursive: false, mode: 0o700 });
    const manifest: RunManifest = {
      schemaVersion: SCHEMA_VERSION,
      id: this.runId,
      startedAt: this.startedAt,
      pid: this.pid,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    };
    writeJsonAtomic(join(this.runDir, 'manifest.json'), manifest);
    this.openInitialSegment();
  }

  currentRun(): PersistedPerfRunSummary {
    return {
      id: this.runId,
      startedAt: this.startedAt,
      endedAt: null,
      status: 'current',
      pid: this.pid,
      sizeBytes: this.currentSizeBytes,
      path: this.runDir,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
    };
  }

  recordSample(sample: PerfSample): void {
    if (this.closed) return;
    void this.enqueueRecords([{
      type: 'sample',
      at: sample.at,
      sample,
      host: {
        freeMemoryMB: Math.round((freemem() / (1024 * 1024)) * 10) / 10,
        totalMemoryMB: Math.round((totalmem() / (1024 * 1024)) * 10) / 10,
      },
    }]);
  }

  recordFreeze(event: PersistedFreezeEvent): void {
    if (this.closed) return;
    // Do not perform disk I/O in the event loop that we are measuring. The
    // worker-thread watchdog writes its own durable off-loop journal if this
    // queue itself is delayed by OS contention or a suspended process.
    void this.enqueueRecords([{ type: 'freeze', at: event.at, event }]);
  }

  recordSlowCall(channel: string, durationMs: number, at = this.now()): void {
    if (this.closed) return;
    this.pendingSlowCalls.push({ type: 'slow_call', at, channel, durationMs: Math.round(durationMs) });
    if (this.slowCallFlush) return;
    this.slowCallFlush = setImmediate(() => {
      this.slowCallFlush = null;
      this.flushSlowCalls();
    });
    this.slowCallFlush.unref?.();
  }

  async recordRendererFreeze(event: PersistedRendererFreeze, requestedRunId?: string): Promise<boolean> {
    return (await this.recordRendererFreezes([event], requestedRunId)) === 1;
  }

  recordRendererFreezes(
    events: PersistedRendererFreeze[],
    requestedRunId?: string,
    report?: PersistedRendererFreezeReport,
  ): Promise<number> {
    if (events.length === 0 || this.closed) return Promise.resolve(0);
    const operation = this.rendererTail.then(() => this.recordRendererFreezesSerial(events, requestedRunId, report));
    this.rendererTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async recordRendererFreezesSerial(
    events: PersistedRendererFreeze[],
    requestedRunId?: string,
    report?: PersistedRendererFreezeReport,
  ): Promise<number> {
    if (this.closed) return 0;
    const target = requestedRunId
      ? await this.findRunAsync(requestedRunId)
      : await this.resolveRunAtAsync(events[0].at);
    if (!target && requestedRunId) return 0;
    const resolvedTarget = target ?? this.currentRun();
    const normalized = target
      ? events
      : events.map((event) => ({ ...event, recoveredToCurrent: true }));
    const seen = this.rendererIdsByRun.get(resolvedTarget.id) ?? new Set<string>();
    this.rendererIdsByRun.set(resolvedTarget.id, seen);
    const fresh = normalized.filter((event) => !seen.has(event.id));
    if (fresh.length === 0 && !report) return events.length;

    const reportRecord: JournalRecord | null = report ? {
      type: 'renderer_freeze_report',
      at: report.lastAt ?? report.createdAt,
      report,
    } : null;

    let written = 0;
    if (resolvedTarget.id === this.runId) {
      const records: JournalRecord[] = fresh.map((event) => ({
        type: 'renderer_freeze',
        at: event.at,
        event,
      }));
      if (reportRecord) records.unshift(reportRecord);
      const writtenRecords = await this.enqueueRecords(records);
      if (reportRecord && writtenRecords === 0) return 0;
      written = Math.max(0, writtenRecords - (reportRecord ? 1 : 0));
      for (const event of fresh.slice(0, written)) seen.add(event.id);
      return events.length - fresh.length + written;
    }

    try {
      const records: JournalRecord[] = fresh.map((event) => ({
        type: 'renderer_freeze', at: event.at, event,
      }));
      if (reportRecord) records.unshift(reportRecord);
      const buffer = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
      const path = await this.recoveredSegmentPathAsync(resolvedTarget, buffer.byteLength);
      await appendFileAsync(path, buffer, { flag: 'a', mode: 0o600 });
      for (const event of fresh) seen.add(event.id);
      const state = this.recoveredSegmentByRun.get(resolvedTarget.id);
      if (state) state.size += buffer.byteLength;
      return events.length;
    } catch (error) {
      this.warnOnce(error);
      return events.length - fresh.length;
    }
  }

  listRuns(): PersistedPerfRunSummary[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.rootDir, entry.name));
    } catch {
      return [];
    }
    return entries
      .map((dir) => dir === this.runDir ? this.currentRun() : this.summaryFor(dir, false))
      .filter((run): run is PersistedPerfRunSummary => !!run)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async listRunsAsync(): Promise<PersistedPerfRunSummary[]> {
    let entries: string[] = [];
    try {
      entries = (await readdirAsync(this.rootDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.rootDir, entry.name));
    } catch {
      return [];
    }
    const runs = await Promise.all(entries.map((dir) =>
      dir === this.runDir ? Promise.resolve(this.currentRun()) : this.summaryForAsync(dir, false)));
    return runs
      .filter((run): run is PersistedPerfRunSummary => !!run)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  readRun(runId: string): PersistedPerfRunDetail | null {
    // Synchronous support reader: callers that target the current run must
    // await flush() first. Production admin routes use readRunAsync().
    const run = this.findRun(runId);
    if (!run) return null;
    const acc = newRunAccumulator(run, Date.now());
    let names: string[] = [];
    try {
      names = readdirSync(run.path).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      acc.read.reasons.add('directory-read-error');
      return finishRunAccumulator(acc);
    }

    noteReadInventory(acc, names, names);
    for (const name of names) {
      const file = join(run.path, name);
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
        acc.read.filesRead++;
        acc.read.bytesRead += Buffer.byteLength(text, 'utf8');
      } catch {
        acc.read.reasons.add('file-read-error');
        continue;
      }
      for (const line of text.split(/\r?\n/)) consumeJournalLine(acc, line);
    }
    return finishRunAccumulator(acc);
  }

  /**
   * Admin/API reader: filesystem work is asynchronous, bytes are capped, and
   * parsing yields in small slices so opening an old run cannot freeze Electron.
   */
  async readRunAsync(runId: string): Promise<PersistedPerfRunDetail | null> {
    if (runId === this.runId) await this.flush();
    const run = await this.findRunAsync(runId);
    if (!run) return null;
    const acc = newRunAccumulator(run, Date.now());
    let allNames: string[];
    try { allNames = await readdirAsync(run.path); } catch {
      acc.read.reasons.add('directory-read-error');
      return finishRunAccumulator(acc);
    }
    const names = boundedReadOrder(allNames);
    noteReadInventory(acc, allNames, names);
    let remaining = ASYNC_READ_RUN_BYTES;
    let parsedLines = 0;
    for (const name of names) {
      if (remaining <= 0) break;
      try {
        const result = await readFileTail(join(run.path, name), Math.min(ASYNC_READ_FILE_BYTES, remaining));
        remaining -= result.bytesRead;
        acc.read.filesRead++;
        acc.read.bytesRead += result.bytesRead;
        if (result.truncated) acc.read.reasons.add('byte-limit');
        for (const line of result.text.split(/\r?\n/)) {
          consumeJournalLine(acc, line);
          parsedLines++;
          if (parsedLines % ASYNC_PARSE_YIELD_LINES === 0) {
            await new Promise<void>((resolveYield) => setImmediate(resolveYield));
          }
        }
      } catch {
        // A segment may rotate between enumeration and open; the rest remain useful.
        acc.read.reasons.add('file-read-error');
      }
    }
    return finishRunAccumulator(acc);
  }

  close(reason = 'graceful'): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.slowCallFlush) clearImmediate(this.slowCallFlush);
    this.slowCallFlush = null;
    const slowCalls = this.takePendingSlowCalls();
    const endedAt = this.now();
    const records = [...slowCalls, { type: 'run_end', at: endedAt, reason } as JournalRecord];
    this.closePromise = (async () => {
      // A renderer request may already be resolving an older run. Let it
      // finish before sealing this run so no append can land after run_end.
      await this.rendererTail;
      const written = await this.enqueueRecords(records, true);
      if (written === records.length) {
        try {
          await writeJsonAtomicAsync(join(this.runDir, 'closed.json'), { endedAt, reason });
        } catch (error) {
          this.warnOnce(error);
        }
      } else {
        this.warnOnce(new Error('run_end was not fully persisted; leaving run interrupted'));
      }
      await this.closeHandle();
    })();
    return this.closePromise;
  }

  /** Test/support hook: close the OS handle without writing a clean marker. */
  async abandon(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    if (this.slowCallFlush) clearImmediate(this.slowCallFlush);
    this.slowCallFlush = null;
    const slowCalls = this.takePendingSlowCalls();
    this.closed = true;
    if (slowCalls.length > 0) await this.enqueueRecords(slowCalls);
    await this.rendererTail;
    await this.writeTail;
    await this.closeHandle();
  }

  /** Wait until records accepted before this call are visible to readers. */
  async flush(): Promise<void> {
    await this.flushSlowCalls();
    await this.rendererTail;
    await this.writeTail;
  }

  /** Low-priority telemetry is coalesced off the caller's request turn. */
  private flushSlowCalls(): Promise<number> {
    if (this.slowCallFlush) clearImmediate(this.slowCallFlush);
    this.slowCallFlush = null;
    const records = this.takePendingSlowCalls();
    if (records.length === 0) return Promise.resolve(0);
    return this.enqueueRecords(records);
  }

  private takePendingSlowCalls(): JournalRecord[] {
    const records = this.pendingSlowCalls;
    this.pendingSlowCalls = [];
    return records;
  }

  private enqueueRecords(records: JournalRecord[], durable = false): Promise<number> {
    if (records.length === 0) return Promise.resolve(0);
    const operation = this.writeTail.then(() => this.appendBatch(records, durable));
    this.writeTail = operation.then(() => undefined, (error) => {
      this.warnOnce(error);
    });
    return operation.catch((error) => {
      this.warnOnce(error);
      return 0;
    });
  }

  /**
   * Append a burst with one asynchronous write per destination segment.
   * Renderer LoAF delivery commonly contains dozens of rows, so each request
   * remains batched while libuv performs disk I/O outside the main JS thread.
   */
  private async appendBatch(records: JournalRecord[], durable = false): Promise<number> {
    if (records.length === 0 || this.fd == null) return 0;
    let writtenRecords = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    const flush = async (): Promise<boolean> => {
      if (pending.length === 0) return true;
      if (this.fd == null) return false;
      const recordCount = pending.length;
      const bytes = pendingBytes;
      const buffer = recordCount === 1 ? pending[0] : Buffer.concat(pending, bytes);
      try {
        await this.writeBuffer(this.fd, buffer);
        this.segmentSize += bytes;
        this.currentSizeBytes += bytes;
        writtenRecords += recordCount;
        pending = [];
        pendingBytes = 0;
        return true;
      } catch (error) {
        this.warnOnce(error);
        return false;
      }
    };

    for (const record of records) {
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      const bytes = buffer.byteLength;
      if (
        this.segmentSize > 0
        && this.segmentSize + pendingBytes + bytes > this.segmentBytes
      ) {
        if (!(await flush())) return writtenRecords;
        try {
          await this.rotateSegment();
        } catch (error) {
          this.warnOnce(error);
          return writtenRecords;
        }
        if (this.fd == null) return writtenRecords;
      }
      pending.push(buffer);
      pendingBytes += bytes;
    }

    await flush();
    if (durable && this.fd != null) {
      try { await syncFdAsync(this.fd); } catch (error) { this.warnOnce(error); }
    }
    return writtenRecords;
  }

  /** Startup is the only synchronous journal I/O; recurring writes are async. */
  private openInitialSegment(): void {
    const path = join(this.runDir, `events-${String(this.segment).padStart(3, '0')}.jsonl`);
    this.fd = openSync(path, 'a', 0o600);
    this.segmentSize = existsSync(path) ? statSync(path).size : 0;
    if (this.segmentSize === 0) {
      const record: JournalRecord = {
        type: 'segment_start',
        at: this.now(),
        runId: this.runId,
        segment: this.segment,
        schemaVersion: SCHEMA_VERSION,
      };
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      writeFully(this.fd, buffer);
      this.segmentSize += buffer.byteLength;
    }
    this.currentSizeBytes = this.segmentSize;
  }

  private async openSegmentAsync(): Promise<void> {
    const path = join(this.runDir, `events-${String(this.segment).padStart(3, '0')}.jsonl`);
    this.fd = await openFdAsync(path);
    try { this.segmentSize = (await statAsync(path)).size; } catch { this.segmentSize = 0; }
    if (this.segmentSize === 0) {
      const record: JournalRecord = {
        type: 'segment_start',
        at: this.now(),
        runId: this.runId,
        segment: this.segment,
        schemaVersion: SCHEMA_VERSION,
      };
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      await this.writeBuffer(this.fd, buffer);
      this.segmentSize += buffer.byteLength;
      this.currentSizeBytes += buffer.byteLength;
    }
  }

  private async rotateSegment(): Promise<void> {
    if (this.fd != null) {
      const fd = this.fd;
      this.fd = null;
      try { await closeFdAsync(fd); } catch { /* process exit will close it */ }
    }
    this.segment++;
    await this.openSegmentAsync();
    try {
      const segments = (await readdirAsync(this.runDir))
        .filter((name) => /^events-\d+\.jsonl$/.test(name))
        .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
      while (segments.length > this.maxSegments) {
        const oldest = segments.shift();
        if (oldest) {
          const path = join(this.runDir, oldest);
          try {
            const size = (await statAsync(path)).size;
            await unlinkAsync(path);
            this.currentSizeBytes = Math.max(0, this.currentSizeBytes - size);
          } catch { /* retention is best-effort */ }
        }
      }
    } catch (error) {
      this.warnOnce(error);
    }
  }

  private async closeHandle(): Promise<void> {
    if (this.fd == null) return;
    const fd = this.fd;
    this.fd = null;
    try { await closeFdAsync(fd); } catch { /* process exit will close it */ }
  }

  private async recoveredSegmentPathAsync(run: PersistedPerfRunSummary, incomingBytes: number): Promise<string> {
    const limit = this.segmentBytes;
    let state = this.recoveredSegmentByRun.get(run.id);
    if (!state) {
      let highest = -1;
      try {
        for (const name of await readdirAsync(run.path)) {
          const match = /^renderer-recovered-(\d+)\.jsonl$/.exec(name);
          if (match) highest = Math.max(highest, Number(match[1]));
        }
      } catch { /* first recovered segment */ }
      const segment = Math.max(0, highest);
      const path = join(run.path, `renderer-recovered-${String(segment).padStart(3, '0')}.jsonl`);
      let size = 0;
      try { size = (await statAsync(path)).size; } catch { /* first recovered segment */ }
      state = { segment, size };
      this.recoveredSegmentByRun.set(run.id, state);
    }
    if (state.size > 0 && state.size + incomingBytes > limit) {
      state.segment++;
      state.size = 0;
      try {
        const segments = (await readdirAsync(run.path))
          .filter((name) => /^renderer-recovered-\d+\.jsonl$/.test(name))
          .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
        while (segments.length >= 2) {
          const oldest = segments.shift();
          if (oldest) await unlinkAsync(join(run.path, oldest));
        }
      } catch (error) {
        this.warnOnce(error);
      }
    }
    return join(run.path, `renderer-recovered-${String(state.segment).padStart(3, '0')}.jsonl`);
  }

  private async resolveRunAtAsync(at: number): Promise<PersistedPerfRunSummary | null> {
    if (at >= this.startedAt) return this.currentRun();
    const runs = (await this.listRunsAsync()).sort((a, b) => a.startedAt - b.startedAt);
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index];
      const next = runs[index + 1];
      if (run.startedAt <= at && (!next || at < next.startedAt)) return run;
    }
    return null;
  }

  private async findRunAsync(runId: string): Promise<PersistedPerfRunSummary | null> {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) return null;
    if (runId === this.runId) return this.currentRun();
    return (await this.listRunsAsync()).find((run) => run.id === runId) ?? null;
  }

  private findRun(runId: string): PersistedPerfRunSummary | null {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) return null;
    if (runId === this.runId) return this.currentRun();
    return this.listRuns().find((run) => run.id === runId) ?? null;
  }

  private summaryFor(dir: string, current: boolean): PersistedPerfRunSummary | null {
    const manifest = manifestFrom(join(dir, 'manifest.json'));
    if (!manifest) return null;
    let sizeBytes = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const stat = statSync(join(dir, name));
        sizeBytes += stat.size;
      }
    } catch { /* partial run directory */ }
    const closed = readJson(join(dir, 'closed.json'));
    const cleanEnd = isRecord(closed) && typeof closed.endedAt === 'number' ? closed.endedAt : null;
    return {
      id: manifest.id,
      startedAt: manifest.startedAt,
      // An interrupted run has no trustworthy end time. A recovered renderer
      // append on the next boot must not move its apparent crash timestamp.
      endedAt: cleanEnd,
      status: current ? 'current' : cleanEnd != null ? 'closed' : 'interrupted',
      pid: manifest.pid,
      sizeBytes,
      path: dir,
      nodeVersion: manifest.nodeVersion,
      electronVersion: manifest.electronVersion,
    };
  }

  private async summaryForAsync(dir: string, current: boolean): Promise<PersistedPerfRunSummary | null> {
    const value = await readJsonAsync(join(dir, 'manifest.json'));
    if (!isRecord(value)) return null;
    if (value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== 'string') return null;
    if (typeof value.startedAt !== 'number' || typeof value.pid !== 'number') return null;
    const manifest = value as unknown as RunManifest;
    let sizeBytes = 0;
    try {
      const names = (await readdirAsync(dir)).filter((name) => name.endsWith('.jsonl'));
      const stats = await Promise.all(names.map((name) => statAsync(join(dir, name)).catch(() => null)));
      sizeBytes = stats.reduce((total, stat) => total + (stat?.size ?? 0), 0);
    } catch { /* partial run directory */ }
    const closed = await readJsonAsync(join(dir, 'closed.json'));
    const cleanEnd = isRecord(closed) && typeof closed.endedAt === 'number' ? closed.endedAt : null;
    return {
      id: manifest.id,
      startedAt: manifest.startedAt,
      endedAt: cleanEnd,
      status: current ? 'current' : cleanEnd != null ? 'closed' : 'interrupted',
      pid: manifest.pid,
      sizeBytes,
      path: dir,
      nodeVersion: manifest.nodeVersion,
      electronVersion: manifest.electronVersion,
    };
  }

  private pruneOldRuns(keep: number): void {
    let dirs: Array<{ dir: string; startedAt: number; pid: number; closed: boolean }> = [];
    try {
      dirs = readdirSync(this.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = join(this.rootDir, entry.name);
          const manifest = manifestFrom(join(dir, 'manifest.json'));
          return manifest ? {
            dir,
            startedAt: manifest.startedAt,
            pid: manifest.pid,
            closed: existsSync(join(dir, 'closed.json')),
          } : null;
        })
        .filter((entry): entry is { dir: string; startedAt: number; pid: number; closed: boolean } => !!entry)
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return;
    }
    for (const stale of dirs.slice(keep)) {
      // A second application instance may share this data directory. Never
      // prune a marker-less run whose owning PID is still alive.
      if (!stale.closed && pidIsAlive(stale.pid)) continue;
      // `stale.dir` came directly from a child directory enumeration under the
      // resolved diagnostics root; never accept caller-provided paths here.
      try { rmSync(stale.dir, { recursive: true, force: true }); } catch { /* retention is best-effort */ }
    }
  }

  private warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[perf-journal] persistent diagnostics degraded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let singleton: PersistentPerfDiagnostics | null = null;

export function startPersistentPerfDiagnostics(options: PersistentPerfDiagnosticsOptions = {}): PersistentPerfDiagnostics | null {
  if (singleton) return singleton;
  try {
    singleton = new PersistentPerfDiagnostics(options);
    return singleton;
  } catch (error) {
    console.warn(`[perf-journal] could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function stopPersistentPerfDiagnostics(reason = 'graceful'): Promise<void> {
  const active = singleton;
  singleton = null;
  await active?.close(reason);
}

export function recordPersistentPerfSample(sample: PerfSample): void {
  singleton?.recordSample(sample);
}

export function recordPersistentFreeze(event: PersistedFreezeEvent): void {
  singleton?.recordFreeze(event);
}

export function recordPersistentSlowCall(channel: string, durationMs: number, at?: number): void {
  singleton?.recordSlowCall(channel, durationMs, at);
}

export function recordPersistentRendererFreeze(event: PersistedRendererFreeze, runId?: string): Promise<boolean> {
  return singleton?.recordRendererFreeze(event, runId) ?? Promise.resolve(false);
}

export function recordPersistentRendererFreezes(
  events: PersistedRendererFreeze[],
  runId?: string,
  report?: PersistedRendererFreezeReport,
): Promise<number> {
  return singleton?.recordRendererFreezes(events, runId, report) ?? Promise.resolve(0);
}

export function listPersistentPerfRuns(): Promise<PersistedPerfRunSummary[]> {
  return singleton?.listRunsAsync() ?? Promise.resolve([]);
}

export async function readPersistentPerfRun(runId: string): Promise<PersistedPerfRunDetail | null> {
  return singleton ? singleton.readRunAsync(runId) : null;
}

export function currentPersistentPerfRun(): PersistedPerfRunSummary | null {
  return singleton?.currentRun() ?? null;
}
