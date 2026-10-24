import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { freemem } from 'node:os';
import { totalmem } from 'node:os';
import { appendFile as appendFileAsync } from 'node:fs/promises';
import { readdir as readdirAsync } from 'node:fs/promises';
import { stat as statAsync } from 'node:fs/promises';
import { unlink as unlinkAsync } from 'node:fs/promises';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { PerfSample } from './perf-sampler-types.js';
import type { PersistedFreezeEvent } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreeze } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreezeReport } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunSummary } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunDetail } from './persistent-diagnostics-types.js';
import type { RunManifest } from './persistent-diagnostics-types.js';
import type { JournalRecord } from './persistent-diagnostics-types.js';
import type { PersistentPerfDiagnosticsOptions } from './persistent-diagnostics-types.js';
import { SCHEMA_VERSION } from './persistent-diagnostics-constants.js';
import { DEFAULT_SEGMENT_BYTES } from './persistent-diagnostics-constants.js';
import { DEFAULT_MAX_SEGMENTS } from './persistent-diagnostics-constants.js';
import { DEFAULT_MAX_RUNS } from './persistent-diagnostics-constants.js';
import { positiveInt } from './persistent-diagnostics-io.js';
import { safeTimestamp } from './persistent-diagnostics-io.js';
import { writeFully } from './persistent-diagnostics-io.js';
import { writeFullyAsync } from './persistent-diagnostics-io.js';
import { openFdAsync } from './persistent-diagnostics-io.js';
import { closeFdAsync } from './persistent-diagnostics-io.js';
import { syncFdAsync } from './persistent-diagnostics-io.js';
import { writeJsonAtomic } from './persistent-diagnostics-io.js';
import { writeJsonAtomicAsync } from './persistent-diagnostics-io.js';
import { prunePerfRuns } from './persistent-diagnostics-io.js';
import { PerfDiagnosticsReader } from './persistent-diagnostics-reader.js';

export class PersistentPerfDiagnostics {
  private readonly reader = new PerfDiagnosticsReader(this);
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
    prunePerfRuns(this.rootDir, Math.max(0, this.maxRuns - 1));
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
  listRuns(): PersistedPerfRunSummary[] { return this.reader.listRuns(); }

  async listRunsAsync(): Promise<PersistedPerfRunSummary[]> { return this.reader.listRunsAsync(); }

  readRun(runId: string): PersistedPerfRunDetail | null { return this.reader.readRun(runId); }

  async readRunAsync(runId: string): Promise<PersistedPerfRunDetail | null> { return this.reader.readRunAsync(runId); }


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
  private async findRunAsync(runId: string): Promise<PersistedPerfRunSummary | null> { return this.reader.findRunAsync(runId); }


  private warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[perf-journal] persistent diagnostics degraded: ${error instanceof Error ? error.message : String(error)}`);
  }
}
