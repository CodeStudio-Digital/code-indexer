/**
 * Crash-resilient performance journal.
 *
 * Each app run owns a small directory under the canonical MCP data directory.
 * Records are appended as JSONL with synchronous writes so Task Manager / a
 * forced process termination can lose at most a partially-written final line,
 * never the whole in-memory diagnostic history. Readers deliberately ignore a
 * malformed tail. A `closed.json` marker is written only on a clean shutdown;
 * its absence lets the next run label the session as interrupted.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { open as openAsync, readdir as readdirAsync } from 'node:fs/promises';
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
  source: 'handler' | 'event-loop' | 'renderer' | 'starved' | 'offloop';
  channel?: string;
  durationMs: number;
  detail?: string;
  count?: number;
  wallLateMs?: number;
  windowMs?: number;
  activeMs?: number;
  busyFraction?: number;
  suspects?: Array<{ channel: string; startedAt: number }>;
  detectedBy?: 'worker-thread';
}

export interface PersistedRendererFreeze {
  id: string;
  at: number;
  durationMs: number;
  name: string;
  script?: string;
  kind: 'loaf' | 'longtask';
  /** Original run aged out before the renderer could retry its outbox. */
  recoveredToCurrent?: boolean;
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
  slowCalls: PersistedSlowCall[];
  recordsRead: number;
  corruptLines: number;
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
  /** Test seam; production uses the partial-write-safe synchronous writer. */
  writeBuffer?: (fd: number, buffer: Buffer) => void;
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

interface RunAccumulator {
  run: PersistedPerfRunSummary;
  samples: PerfSample[];
  freezes: PersistedFreezeEvent[];
  rendererFreezes: PersistedRendererFreeze[];
  rendererIds: Set<string>;
  slow: SlowAccumulator;
  recordsRead: number;
  corruptLines: number;
}

function newRunAccumulator(run: PersistedPerfRunSummary): RunAccumulator {
  return {
    run,
    samples: [],
    freezes: [],
    rendererFreezes: [],
    rendererIds: new Set(),
    slow: new Map(),
    recordsRead: 0,
    corruptLines: 0,
  };
}

function consumeJournalLine(acc: RunAccumulator, line: string): void {
  if (!line.trim()) return;
  let record: unknown;
  try { record = JSON.parse(line) as unknown; } catch { acc.corruptLines++; return; }
  if (!isRecord(record) || typeof record.type !== 'string') { acc.corruptLines++; return; }
  acc.recordsRead++;
  if (record.type === 'sample' && isRecord(record.sample)) {
    boundedPush(acc.samples, record.sample as unknown as PerfSample, SAMPLE_LIMIT);
  } else if (record.type === 'freeze' && isRecord(record.event)) {
    boundedPush(acc.freezes, record.event as unknown as PersistedFreezeEvent, FREEZE_LIMIT);
  } else if (record.type === 'renderer_freeze' && isRecord(record.event)) {
    const event = record.event as unknown as PersistedRendererFreeze;
    if (typeof event.id === 'string' && !acc.rendererIds.has(event.id)) {
      acc.rendererIds.add(event.id);
      boundedPush(acc.rendererFreezes, event, RENDERER_LIMIT);
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
  return {
    run: acc.run,
    samples: acc.samples,
    freezes: acc.freezes,
    rendererFreezes: acc.rendererFreezes,
    slowCalls,
    recordsRead: acc.recordsRead,
    corruptLines: acc.corruptLines,
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
  private readonly writeBuffer: (fd: number, buffer: Buffer) => void;
  private segment = 0;
  private segmentSize = 0;
  private fd: number | null = null;
  private closed = false;
  private warned = false;
  private readonly rendererIdsByRun = new Map<string, Set<string>>();
  private readonly recoveredSegmentByRun = new Map<string, { segment: number; size: number }>();

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
    this.writeBuffer = options.writeBuffer ?? writeFully;

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
    this.openSegment();
  }

  currentRun(): PersistedPerfRunSummary {
    return this.summaryFor(this.runDir, true)!;
  }

  recordSample(sample: PerfSample): void {
    this.append({
      type: 'sample',
      at: sample.at,
      sample,
      host: {
        freeMemoryMB: Math.round((freemem() / (1024 * 1024)) * 10) / 10,
        totalMemoryMB: Math.round((totalmem() / (1024 * 1024)) * 10) / 10,
      },
    });
  }

  recordFreeze(event: PersistedFreezeEvent): void {
    // A synchronous append survives a forced process exit without adding an
    // fsync-sized pause to the event loop we are trying to diagnose.
    this.append({ type: 'freeze', at: event.at, event });
  }

  recordSlowCall(channel: string, durationMs: number, at = this.now()): void {
    this.append({ type: 'slow_call', at, channel, durationMs: Math.round(durationMs) });
  }

  recordRendererFreeze(event: PersistedRendererFreeze, requestedRunId?: string): boolean {
    return this.recordRendererFreezes([event], requestedRunId) === 1;
  }

  recordRendererFreezes(events: PersistedRendererFreeze[], requestedRunId?: string): number {
    if (events.length === 0) return 0;
    const target = requestedRunId
      ? this.findRun(requestedRunId)
      : this.resolveRunAt(events[0].at);
    if (!target && requestedRunId) return 0;
    const resolvedTarget = target ?? this.currentRun();
    const normalized = target
      ? events
      : events.map((event) => ({ ...event, recoveredToCurrent: true }));
    const seen = this.rendererIdsByRun.get(resolvedTarget.id) ?? new Set<string>();
    this.rendererIdsByRun.set(resolvedTarget.id, seen);
    const fresh = normalized.filter((event) => !seen.has(event.id));
    if (fresh.length === 0) return events.length;

    let written = 0;
    if (resolvedTarget.id === this.runId) {
      written = this.appendBatch(fresh.map((event) => ({
        type: 'renderer_freeze',
        at: event.at,
        event,
      })));
      for (const event of fresh.slice(0, written)) seen.add(event.id);
      return events.length - fresh.length + written;
    }

    try {
      const buffer = Buffer.from(fresh.map((event) => JSON.stringify({
        type: 'renderer_freeze', at: event.at, event,
      } satisfies JournalRecord)).join('\n') + '\n', 'utf8');
      const path = this.recoveredSegmentPath(resolvedTarget, buffer.byteLength);
      appendFileSync(path, buffer, { flag: 'a', mode: 0o600 });
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
      .map((dir) => this.summaryFor(dir, dir === this.runDir))
      .filter((run): run is PersistedPerfRunSummary => !!run)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  readRun(runId: string): PersistedPerfRunDetail | null {
    const run = this.findRun(runId);
    if (!run) return null;
    const acc = newRunAccumulator(run);
    let files: string[] = [];
    try {
      files = readdirSync(run.path)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(run.path, name));
    } catch {
      return finishRunAccumulator(acc);
    }

    for (const file of files) {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) consumeJournalLine(acc, line);
    }
    return finishRunAccumulator(acc);
  }

  /**
   * Admin/API reader: filesystem work is asynchronous, bytes are capped, and
   * parsing yields in small slices so opening an old run cannot freeze Electron.
   */
  async readRunAsync(runId: string): Promise<PersistedPerfRunDetail | null> {
    const run = this.findRun(runId);
    if (!run) return null;
    const acc = newRunAccumulator(run);
    let names: string[];
    try { names = boundedReadOrder(await readdirAsync(run.path)); } catch { return finishRunAccumulator(acc); }
    let remaining = ASYNC_READ_RUN_BYTES;
    let parsedLines = 0;
    for (const name of names) {
      if (remaining <= 0) break;
      try {
        const result = await readFileTail(join(run.path, name), Math.min(ASYNC_READ_FILE_BYTES, remaining));
        remaining -= result.bytesRead;
        if (result.truncated) acc.corruptLines++;
        for (const line of result.text.split(/\r?\n/)) {
          consumeJournalLine(acc, line);
          parsedLines++;
          if (parsedLines % ASYNC_PARSE_YIELD_LINES === 0) {
            await new Promise<void>((resolveYield) => setImmediate(resolveYield));
          }
        }
      } catch {
        // A segment may rotate between enumeration and open; the rest remain useful.
      }
    }
    return finishRunAccumulator(acc);
  }

  close(reason = 'graceful'): void {
    if (this.closed) return;
    const endedAt = this.now();
    this.append({ type: 'run_end', at: endedAt, reason }, true);
    try {
      writeJsonAtomic(join(this.runDir, 'closed.json'), { endedAt, reason });
    } catch (error) {
      this.warnOnce(error);
    }
    this.closed = true;
    if (this.fd != null) {
      try { closeSync(this.fd); } catch { /* process exit will close it */ }
      this.fd = null;
    }
  }

  /** Test/support hook: close the OS handle without writing a clean marker. */
  abandon(): void {
    if (this.fd != null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.closed = true;
  }

  private append(record: JournalRecord, durable = false): boolean {
    if (this.closed || this.fd == null) return false;
    try {
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      const bytes = buffer.byteLength;
      if (this.segmentSize > 0 && this.segmentSize + bytes > this.segmentBytes) this.rotateSegment();
      if (this.fd == null) return false;
      this.writeBuffer(this.fd, buffer);
      this.segmentSize += bytes;
      if (durable) fdatasyncSync(this.fd);
      return true;
    } catch (error) {
      this.warnOnce(error);
      return false;
    }
  }

  /**
   * Append a burst with one synchronous write per destination segment. Renderer
   * LoAF delivery commonly contains dozens of rows; writing every line
   * separately made the diagnostic endpoint observable as its own freeze.
   */
  private appendBatch(records: JournalRecord[]): number {
    if (records.length === 0 || this.closed || this.fd == null) return 0;
    let writtenRecords = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    const flush = (): boolean => {
      if (pending.length === 0) return true;
      if (this.fd == null) return false;
      const recordCount = pending.length;
      const bytes = pendingBytes;
      const buffer = recordCount === 1 ? pending[0] : Buffer.concat(pending, bytes);
      try {
        this.writeBuffer(this.fd, buffer);
        this.segmentSize += bytes;
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
        if (!flush()) return writtenRecords;
        try {
          this.rotateSegment();
        } catch (error) {
          this.warnOnce(error);
          return writtenRecords;
        }
        if (this.fd == null) return writtenRecords;
      }
      pending.push(buffer);
      pendingBytes += bytes;
    }

    flush();
    return writtenRecords;
  }

  private openSegment(): void {
    const path = join(this.runDir, `events-${String(this.segment).padStart(3, '0')}.jsonl`);
    this.fd = openSync(path, 'a', 0o600);
    this.segmentSize = existsSync(path) ? statSync(path).size : 0;
    if (this.segmentSize === 0) {
      this.append({
        type: 'segment_start',
        at: this.now(),
        runId: this.runId,
        segment: this.segment,
        schemaVersion: SCHEMA_VERSION,
      });
    }
  }

  private rotateSegment(): void {
    if (this.fd != null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.segment++;
    this.openSegment();
    try {
      const segments = readdirSync(this.runDir)
        .filter((name) => /^events-\d+\.jsonl$/.test(name))
        .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
      while (segments.length > this.maxSegments) {
        const oldest = segments.shift();
        if (oldest) unlinkSync(join(this.runDir, oldest));
      }
    } catch (error) {
      this.warnOnce(error);
    }
  }

  private recoveredSegmentPath(run: PersistedPerfRunSummary, incomingBytes: number): string {
    const limit = this.segmentBytes;
    let state = this.recoveredSegmentByRun.get(run.id);
    if (!state) {
      let highest = -1;
      try {
        for (const name of readdirSync(run.path)) {
          const match = /^renderer-recovered-(\d+)\.jsonl$/.exec(name);
          if (match) highest = Math.max(highest, Number(match[1]));
        }
      } catch { /* first recovered segment */ }
      const segment = Math.max(0, highest);
      const path = join(run.path, `renderer-recovered-${String(segment).padStart(3, '0')}.jsonl`);
      state = { segment, size: existsSync(path) ? statSync(path).size : 0 };
      this.recoveredSegmentByRun.set(run.id, state);
    }
    if (state.size > 0 && state.size + incomingBytes > limit) {
      state.segment++;
      state.size = 0;
      try {
        const segments = readdirSync(run.path)
          .filter((name) => /^renderer-recovered-\d+\.jsonl$/.test(name))
          .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
        while (segments.length >= 2) {
          const oldest = segments.shift();
          if (oldest) unlinkSync(join(run.path, oldest));
        }
      } catch (error) {
        this.warnOnce(error);
      }
    }
    return join(run.path, `renderer-recovered-${String(state.segment).padStart(3, '0')}.jsonl`);
  }

  private resolveRunAt(at: number): PersistedPerfRunSummary | null {
    const runs = this.listRuns().sort((a, b) => a.startedAt - b.startedAt);
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index];
      const next = runs[index + 1];
      if (run.startedAt <= at && (!next || at < next.startedAt)) return run;
    }
    return null;
  }

  private findRun(runId: string): PersistedPerfRunSummary | null {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) return null;
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

export function stopPersistentPerfDiagnostics(reason = 'graceful'): void {
  singleton?.close(reason);
  singleton = null;
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

export function recordPersistentRendererFreeze(event: PersistedRendererFreeze, runId?: string): boolean {
  return singleton?.recordRendererFreeze(event, runId) ?? false;
}

export function recordPersistentRendererFreezes(events: PersistedRendererFreeze[], runId?: string): number {
  return singleton?.recordRendererFreezes(events, runId) ?? 0;
}

export function listPersistentPerfRuns(): PersistedPerfRunSummary[] {
  return singleton?.listRuns() ?? [];
}

export async function readPersistentPerfRun(runId: string): Promise<PersistedPerfRunDetail | null> {
  return singleton ? singleton.readRunAsync(runId) : null;
}

export function currentPersistentPerfRun(): PersistedPerfRunSummary | null {
  return singleton?.currentRun() ?? null;
}
