import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { readdir as readdirAsync } from 'node:fs/promises';
import { stat as statAsync } from 'node:fs/promises';
import type { PersistedPerfRunSummary } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunDetail } from './persistent-diagnostics-types.js';
import type { RunManifest } from './persistent-diagnostics-types.js';
import { SCHEMA_VERSION } from './persistent-diagnostics-constants.js';
import { ASYNC_READ_FILE_BYTES } from './persistent-diagnostics-constants.js';
import { ASYNC_READ_RUN_BYTES } from './persistent-diagnostics-constants.js';
import { ASYNC_PARSE_YIELD_LINES } from './persistent-diagnostics-constants.js';
import { isRecord } from './persistent-diagnostics-io.js';
import { readJson } from './persistent-diagnostics-io.js';
import { readJsonAsync } from './persistent-diagnostics-io.js';
import { manifestFrom } from './persistent-diagnostics-io.js';
import { readFileTail } from './persistent-diagnostics-io.js';
import { newRunAccumulator } from './persistent-diagnostics-parser.js';
import { consumeJournalLine } from './persistent-diagnostics-parser.js';
import { finishRunAccumulator } from './persistent-diagnostics-parser.js';
import { boundedReadOrder } from './persistent-diagnostics-parser.js';
import { noteReadInventory } from './persistent-diagnostics-parser.js';

export class PerfDiagnosticsReader {
  constructor(private readonly source: {
    rootDir: string; runId: string; runDir: string;
    currentRun(): PersistedPerfRunSummary; flush(): Promise<void>;
  }) {}


  listRuns(): PersistedPerfRunSummary[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.source.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.source.rootDir, entry.name));
    } catch {
      return [];
    }
    return entries
      .map((dir) => dir === this.source.runDir ? this.source.currentRun() : this.summaryFor(dir, false))
      .filter((run): run is PersistedPerfRunSummary => !!run)
      .sort((a, b) => b.startedAt - a.startedAt);
  }


  async listRunsAsync(): Promise<PersistedPerfRunSummary[]> {
    let entries: string[] = [];
    try {
      entries = (await readdirAsync(this.source.rootDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.source.rootDir, entry.name));
    } catch {
      return [];
    }
    const runs = await Promise.all(entries.map((dir) =>
      dir === this.source.runDir ? Promise.resolve(this.source.currentRun()) : this.summaryForAsync(dir, false)));
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
    if (runId === this.source.runId) await this.source.flush();
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


  async findRunAsync(runId: string): Promise<PersistedPerfRunSummary | null> {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) return null;
    if (runId === this.source.runId) return this.source.currentRun();
    return (await this.listRunsAsync()).find((run) => run.id === runId) ?? null;
  }


  findRun(runId: string): PersistedPerfRunSummary | null {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) return null;
    if (runId === this.source.runId) return this.source.currentRun();
    return this.listRuns().find((run) => run.id === runId) ?? null;
  }


  summaryFor(dir: string, current: boolean): PersistedPerfRunSummary | null {
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


  async summaryForAsync(dir: string, current: boolean): Promise<PersistedPerfRunSummary | null> {
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
}
