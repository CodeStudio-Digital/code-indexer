/**
 * Shape of one row in the task manager, and the pure assembly that produces
 * the list from a census tree plus whatever labelling sources are available.
 *
 * Three row sources are merged here:
 *   - `os`       — real processes from the census tree (the whole point)
 *   - `electron` — fallback rows used while the collector is warming or has
 *                  failed, so the panel is never empty
 *   - `worker`   — worker_thread isolates, which are NOT processes: they share
 *                  the main pid and only V8 can see their heaps. They are shown
 *                  nested under main and excluded from memory totals so the
 *                  footer still matches Task Manager.
 */
import type { CensusTree } from '@mcp/shared/utils/process-census/tree.js';
import type { DerivedRates } from '@mcp/shared/utils/process-census/types.js';

export type TaskKind =
  | 'main' | 'renderer' | 'gpu' | 'utility' | 'worker'
  | 'terminal' | 'runner' | 'devserver' | 'lsp' | 'debug'
  | 'mcp' | 'git' | 'sandbox' | 'helper' | 'unknown';

export interface TaskRow {
  /** Unique across sources — worker rows share the main process's pid. */
  id: string;
  pid: number;
  ppid: number;
  depth: number;
  kind: TaskKind;
  label: string;
  exe: string;
  command?: string;
  memoryMB: number;
  privateMB?: number;
  cpuPercent: number | null;
  diskBytesPerSec: number | null;
  source: 'os' | 'electron' | 'worker';
  /** Subtree whose spawning parent already died. */
  orphaned: boolean;
  /** Excluded from the memory total (worker heaps live inside main's RSS). */
  countsTowardTotal: boolean;
  killable: boolean;
  killReason?: string;
  /** Registry id enabling a graceful shutdown instead of a tree kill. */
  ownerId?: string;
}

export interface ElectronProcessInfo {
  type: string;
  name: string;
  workingSetMB: number;
  cpuPercent: number;
}

/** Minimal view of a labelling entry; the full inventory lands in wave 3. */
export interface TaskLabel {
  kind: TaskKind;
  label: string;
  ownerId?: string;
}

export interface WorkerRowInput {
  /** Stable within its kind, e.g. `company#12`. */
  id: string;
  label: string;
  heapUsedMB: number;
}

export interface BuildTaskRowsInput {
  tree: CensusTree;
  rates: Map<number, DerivedRates>;
  commandLines: Map<number, string>;
  mainPid: number;
  electronByPid: Map<number, ElectronProcessInfo>;
  /** Authoritative labels keyed by pid (registries first, heuristics after). */
  labels: Map<number, TaskLabel>;
  workers: WorkerRowInput[];
}

const bytesToMB = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Electron's process types are capitalised and inconsistent across versions. */
export function kindFromElectronType(type: string): TaskKind {
  const normalized = type.toLowerCase();
  if (normalized === 'browser') return 'main';
  if (normalized === 'gpu') return 'gpu';
  if (normalized === 'tab' || normalized === 'renderer') return 'renderer';
  if (normalized === 'utility') return 'utility';
  return 'unknown';
}

function osRow(
  node: CensusTree['ordered'][number],
  input: BuildTaskRowsInput,
): TaskRow {
  const { row, depth, orphaned } = node;
  const rates = input.rates.get(row.pid);
  const electron = input.electronByPid.get(row.pid);
  const label = input.labels.get(row.pid);
  const command = input.commandLines.get(row.pid);

  const kind = label?.kind
    ?? (row.pid === input.mainPid ? 'main' : undefined)
    ?? (electron ? kindFromElectronType(electron.type) : undefined)
    ?? 'unknown';

  return {
    id: `os:${row.pid}`,
    pid: row.pid,
    ppid: row.ppid,
    depth,
    kind,
    label: label?.label || electron?.name || row.exe || `PID ${row.pid}`,
    exe: row.exe,
    command,
    memoryMB: bytesToMB(row.workingSetBytes),
    privateMB: row.privateBytes === undefined ? undefined : bytesToMB(row.privateBytes),
    // Electron's own percentCPUUsage is a fine stand-in on the very first
    // frame, when the census has no previous sample to diff against.
    cpuPercent: rates?.cpuPercent ?? electron?.cpuPercent ?? null,
    diskBytesPerSec: rates?.diskBytesPerSec ?? null,
    source: 'os',
    orphaned,
    countsTowardTotal: true,
    killable: false,
    ownerId: label?.ownerId,
  };
}

function electronFallbackRows(input: BuildTaskRowsInput): TaskRow[] {
  return [...input.electronByPid.entries()]
    .sort((a, b) => b[1].workingSetMB - a[1].workingSetMB || a[0] - b[0])
    .map(([pid, info]) => ({
      id: `electron:${pid}`,
      pid,
      ppid: pid === input.mainPid ? 0 : input.mainPid,
      depth: pid === input.mainPid ? 0 : 1,
      kind: kindFromElectronType(info.type),
      label: info.name || info.type,
      exe: info.type,
      memoryMB: info.workingSetMB,
      cpuPercent: info.cpuPercent,
      diskBytesPerSec: null,
      source: 'electron' as const,
      orphaned: false,
      countsTowardTotal: true,
      killable: false,
    }));
}

function workerRows(input: BuildTaskRowsInput, mainDepth: number): TaskRow[] {
  return input.workers.map((worker) => ({
    id: `worker:${worker.id}`,
    pid: input.mainPid,
    ppid: input.mainPid,
    depth: mainDepth + 1,
    kind: 'worker' as const,
    label: worker.label,
    exe: 'worker_thread',
    memoryMB: worker.heapUsedMB,
    cpuPercent: null,
    diskBytesPerSec: null,
    source: 'worker' as const,
    orphaned: false,
    // Their heap is already inside the main process's working set.
    countsTowardTotal: false,
    killable: false,
    killReason: 'worker_thread',
  }));
}

/**
 * Assemble the display list. Worker rows are spliced in right after the main
 * process so the tree reads top-down without a second pass in the UI.
 */
export function buildTaskRows(input: BuildTaskRowsInput): TaskRow[] {
  const base = input.tree.ordered.length > 0
    ? input.tree.ordered.map((node) => osRow(node, input))
    : electronFallbackRows(input);

  if (input.workers.length === 0) return base;

  const mainIndex = base.findIndex((row) => row.pid === input.mainPid && row.source !== 'worker');
  if (mainIndex < 0) return [...base, ...workerRows(input, 0)];
  const nested = workerRows(input, base[mainIndex]!.depth);
  return [...base.slice(0, mainIndex + 1), ...nested, ...base.slice(mainIndex + 1)];
}
