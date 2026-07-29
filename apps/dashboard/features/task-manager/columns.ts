/**
 * Column model for the task manager: the wire types, the formatters and the
 * comparators.
 *
 * Formatting lives in a `.ts` file rather than inside the components on
 * purpose — unit suffixes (MB, %, KB/s) are technical literals, and keeping
 * them out of JSX keeps the i18n literal-baseline test honest about which
 * strings are actually user-facing prose.
 */

export type TaskKind =
  | 'main' | 'renderer' | 'gpu' | 'utility' | 'worker'
  | 'terminal' | 'runner' | 'devserver' | 'lsp' | 'debug'
  | 'mcp' | 'git' | 'sandbox' | 'helper' | 'unknown';

export interface TaskRow {
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
  orphaned: boolean;
  countsTowardTotal: boolean;
  killable: boolean;
  killReason?: string;
  ownerId?: string;
}

export interface ProcessSnapshot {
  at: number;
  mainPid: number;
  cores: number;
  status: 'stopped' | 'warming' | 'live' | 'failed' | 'electron-only';
  rows: TaskRow[];
  totals: { memoryMB: number; cpuPercent: number; count: number };
}

export type SortKey = 'label' | 'kind' | 'pid' | 'memoryMB' | 'cpuPercent' | 'diskBytesPerSec';
export type SortDir = 'asc' | 'desc';

export const REFRESH_OPTIONS = [1_000, 2_000, 5_000] as const;

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/** `null` means "not derivable yet", which must not read as idle. */
export function formatCpu(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

export function formatDisk(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return '—';
  if (bytesPerSec < 1024) return '—';
  const kb = bytesPerSec / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb.toFixed(0)} KB/s`;
}

export function formatInterval(ms: number): string {
  return `${ms / 1000}s`;
}

/**
 * Sort a flat list. Nulls always sink regardless of direction — a process
 * whose CPU is not yet derivable is not "the quietest one".
 */
export function compareRows(a: TaskRow, b: TaskRow, key: SortKey, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'label' || key === 'kind') {
    return sign * String(a[key]).localeCompare(String(b[key])) || a.pid - b.pid;
  }
  const left = a[key];
  const right = b[key];
  if (left === null && right === null) return a.pid - b.pid;
  if (left === null) return 1;
  if (right === null) return -1;
  return sign * (left - right) || a.pid - b.pid;
}
