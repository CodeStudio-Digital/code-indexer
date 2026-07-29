/**
 * Assembles one task-manager snapshot from every available source.
 *
 * Shared by `GET /api/admin/processes` and the kill endpoint — the latter has
 * to re-derive the same process tree to answer "does the app actually own this
 * pid?", and deriving it twice from different code would be exactly the kind
 * of drift that turns a guard into a hole.
 *
 * Fully synchronous by design: it reads a frame the collector already built
 * and the perf sampler's last background sample, never awaiting a worker RPC.
 */
import { cpus } from 'node:os';
import { deriveRates } from '@mcp/shared/utils/process-census/cpu-derive.js';
import { buildDescendantTree, type CensusTree } from '@mcp/shared/utils/process-census/tree.js';
import type { DerivedRates } from '@mcp/shared/utils/process-census/types.js';
import { censusSnapshot } from './census-service.js';
import { classifyProcess } from './classify.js';
import { evaluateKill, type KillContext } from './kill-guard.js';
import { buildTaskRows, type ElectronProcessInfo, type TaskLabel, type TaskRow } from './task-rows.js';
import {
  collectProcessInventory,
  type ProcessInventoryEntry,
} from '../process-inventory.js';
import { getPerfSampler } from '../perf-sampler.js';
import type { ProcessMetricLike } from '../perf-sampler.js';
import { workerRowsFromSample } from './worker-rows.js';

const EMPTY_TREE: CensusTree = { ordered: [], descendants: new Set() };
/** Label Electron gives the window that hosts the dashboard UI. */
const DASHBOARD_LABEL = 'Dashboard';

export interface ProcessSnapshotSources {
  processMetricsProvider?: () => ProcessMetricLike[] | null;
  processInventoryProvider?: () => ProcessInventoryEntry[];
}

export interface ProcessSnapshot {
  at: number;
  mainPid: number;
  cores: number;
  status: string;
  rows: TaskRow[];
  totals: { memoryMB: number; cpuPercent: number; count: number };
  killContext: KillContext;
  owners: Map<number, ProcessInventoryEntry>;
}

function electronProcessMap(metrics: ProcessMetricLike[] | null): Map<number, ElectronProcessInfo> {
  const out = new Map<number, ElectronProcessInfo>();
  for (const metric of metrics ?? []) {
    out.set(metric.pid, {
      type: metric.type,
      name: metric.name ?? metric.serviceName ?? '',
      // Electron reports working set in KILOBYTES.
      workingSetMB: Math.round(((metric.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
      cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
    });
  }
  return out;
}

function totalsOf(rows: TaskRow[]): ProcessSnapshot['totals'] {
  let memoryMB = 0;
  let cpuPercent = 0;
  let count = 0;
  for (const row of rows) {
    if (!row.countsTowardTotal) continue;
    memoryMB += row.memoryMB;
    cpuPercent += row.cpuPercent ?? 0;
    count += 1;
  }
  return {
    memoryMB: Math.round(memoryMB),
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    count,
  };
}

/**
 * @param intervalMs collector sample rate. Omit it when the caller is not the
 *   polling loop — see `censusSnapshot`.
 */
export function buildProcessSnapshot(
  sources: ProcessSnapshotSources,
  intervalMs?: number,
): ProcessSnapshot {
  const census = censusSnapshot(intervalMs);
  const cores = cpus().length || 1;
  const mainPid = process.pid;

  const electronByPid = electronProcessMap(sources.processMetricsProvider?.() ?? null);
  const inventory = collectProcessInventory(() => sources.processInventoryProvider?.() ?? []);

  // Owned pids become adoptable roots, so a dev server whose terminal already
  // died stays visible — and killable — instead of vanishing from the tree.
  const tree = census.frame
    ? buildDescendantTree(census.frame.rows, mainPid, inventory.ownedPids)
    : EMPTY_TREE;
  const rates = census.frame
    ? deriveRates(census.previous, census.frame, cores)
    : new Map<number, DerivedRates>();

  const labels = new Map<number, TaskLabel>();
  for (const [pid, entry] of inventory.labels) {
    labels.set(pid, { kind: entry.kind, label: entry.label, ownerId: entry.ownerId });
  }
  // Registries are authoritative; the classifier only names what they cannot
  // see — LSP servers, terminal grandchildren, git, build helpers.
  for (const node of tree.ordered) {
    if (labels.has(node.row.pid)) continue;
    const guess = classifyProcess(node.row.exe, census.frame?.commandLines.get(node.row.pid));
    if (guess) labels.set(node.row.pid, guess);
  }

  const rows = buildTaskRows({
    tree,
    rates,
    commandLines: census.frame?.commandLines ?? new Map(),
    mainPid,
    electronByPid,
    labels,
    workers: workerRowsFromSample(getPerfSampler()?.getCurrent() ?? null),
  });

  const dashboardPids = new Set<number>();
  const electronTypeByPid = new Map<number, string>();
  for (const [pid, info] of electronByPid) {
    electronTypeByPid.set(pid, info.type);
    if (info.name === DASHBOARD_LABEL) dashboardPids.add(pid);
  }
  const killContext: KillContext = {
    mainPid,
    descendants: tree.descendants,
    electronTypeByPid,
    dashboardPids,
  };

  // One evaluation feeds both the button state and the endpoint, so they can
  // never disagree about what is allowed.
  for (const row of rows) {
    if (row.source === 'worker') continue;
    const verdict = evaluateKill(row.pid, killContext);
    row.killable = verdict.ok;
    if (!verdict.ok) row.killReason = verdict.code;
  }

  return {
    at: census.frame?.at ?? Date.now(),
    mainPid,
    cores,
    // `electron-only` is the honest status when the collector has nothing yet
    // but Electron metrics carried the panel.
    status: census.frame
      ? census.status
      : (electronByPid.size > 0 ? 'electron-only' : census.status),
    rows,
    totals: totalsOf(rows),
    killContext,
    owners: inventory.labels,
  };
}
