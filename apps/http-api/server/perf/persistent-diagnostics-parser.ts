import type { PerfSample } from './perf-sampler-types.js';
import type { PersistedFreezeEvent } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreeze } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreezeReport } from './persistent-diagnostics-types.js';
import type { PersistedSlowCall } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunSummary } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunDetail } from './persistent-diagnostics-types.js';
import { SAMPLE_LIMIT } from './persistent-diagnostics-constants.js';
import { FREEZE_LIMIT } from './persistent-diagnostics-constants.js';
import { RENDERER_LIMIT } from './persistent-diagnostics-constants.js';
import { SLOW_SAMPLE_CAP } from './persistent-diagnostics-constants.js';
import { MAX_SLOW_CHANNELS } from './persistent-diagnostics-constants.js';
import { ASYNC_READ_FILE_BYTES } from './persistent-diagnostics-constants.js';
import { ASYNC_READ_RUN_BYTES } from './persistent-diagnostics-constants.js';
import { isRecord } from './persistent-diagnostics-io.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function boundedPush<T>(rows: T[], value: T, limit: number): void {
  rows.push(value);
  if (rows.length > limit) rows.splice(0, rows.length - limit);
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

export function newRunAccumulator(run: PersistedPerfRunSummary, cutoffAt: number): RunAccumulator {
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

export function consumeJournalLine(acc: RunAccumulator, line: string): void {
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

export function finishRunAccumulator(acc: RunAccumulator): PersistedPerfRunDetail {
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

export function boundedReadOrder(names: string[]): string[] {
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

export function noteReadInventory(acc: RunAccumulator, names: string[], selected: string[]): void {
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
