/**
 * Aggregates every registry that knows an OS pid into one lookup.
 *
 * The IDE's process knowledge is spread across islands — the PTY manager, the
 * local dev-process manager, the MCP pool, the shared tree tracker, and (in
 * Electron) the child registry. None of them sees the others. This module is
 * the join, and it produces two things:
 *
 *   - `labels`   — pid → human description, so a row reads "Terminal: my-app"
 *                  instead of "node.exe", plus the owner id that lets the kill
 *                  path shut a process down gracefully through its manager.
 *   - `ownedPids` — every pid the app still owns, fed to the census tree as
 *                  adoptable roots. Without it, a dev server whose terminal
 *                  died would silently disappear from the panel while still
 *                  holding its port.
 *
 * Every source is wrapped individually: one broken registry must not blank the
 * whole task manager.
 */
import { sharedPtyManager } from '@mcp/api-handlers';
import { listTrackedProcessTrees } from '@mcp/shared/utils/process-tree.js';
import { tryGetLocalProcessManager } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';
import { getGlobalMcpExternalPool } from '../../sse/McpExternalPool.js';
import type { TaskKind } from './census/task-rows.js';

export interface ProcessInventoryEntry {
  pid: number;
  kind: TaskKind;
  label: string;
  /** Working directory or another disambiguating detail. */
  detail?: string;
  /** Id understood by `ownerKind`'s manager — enables a graceful stop. */
  ownerId?: string;
  ownerKind?: 'pty' | 'local-process' | 'mcp';
}

export interface ProcessInventory {
  labels: Map<number, ProcessInventoryEntry>;
  /** Pids the app owns, including those with no label of their own. */
  ownedPids: number[];
}

function safely(collect: () => ProcessInventoryEntry[]): ProcessInventoryEntry[] {
  try {
    return collect();
  } catch {
    return [];
  }
}

function fromPtys(): ProcessInventoryEntry[] {
  return sharedPtyManager.listEntries().map((entry) => ({
    pid: entry.pid,
    kind: entry.meta?.kind === 'runner' ? ('runner' as const) : ('terminal' as const),
    label: entry.meta?.label ?? `Terminal ${entry.id.slice(0, 8)}`,
    detail: entry.meta?.cwd,
    ownerId: entry.id,
    ownerKind: 'pty' as const,
  }));
}

function fromLocalProcesses(): ProcessInventoryEntry[] {
  const manager = tryGetLocalProcessManager();
  if (!manager) return [];
  const out: ProcessInventoryEntry[] = [];
  for (const proc of manager.listAll()) {
    if (typeof proc.pid !== 'number' || proc.pid <= 0) continue;
    out.push({
      pid: proc.pid,
      kind: 'devserver',
      label: `Dev server: ${proc.program}`,
      detail: proc.cwd,
      ownerId: proc.sessionId,
      ownerKind: 'local-process',
    });
  }
  return out;
}

function fromMcpServers(): ProcessInventoryEntry[] {
  const pool = getGlobalMcpExternalPool();
  if (!pool) return [];
  return pool.listStdioProcesses().map((server) => ({
    pid: server.pid,
    kind: 'mcp' as const,
    label: `MCP: ${server.name}`,
    ownerId: server.serverId,
    ownerKind: 'mcp' as const,
  }));
}

/**
 * Build the inventory.
 *
 * @param extra Electron-only source (the child registry), injected because
 *   http-api cannot import `electron`. Same late-injection contract as
 *   `processMetricsProvider`: always call it through a closure.
 */
export function collectProcessInventory(
  extra?: () => ProcessInventoryEntry[],
): ProcessInventory {
  const labels = new Map<number, ProcessInventoryEntry>();
  const ownedPids = new Set<number>();

  // Later sources do not overwrite earlier ones: the PTY manager knows more
  // about a terminal than the child registry's generic 'terminal:host' label.
  const sources = [fromPtys, fromLocalProcesses, fromMcpServers, ...(extra ? [extra] : [])];
  for (const source of sources) {
    for (const entry of safely(source)) {
      if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
      ownedPids.add(entry.pid);
      if (!labels.has(entry.pid)) labels.set(entry.pid, entry);
    }
  }

  // LSP servers and debug adapters register here for shutdown but expose no
  // label — the command-line classifier names them. What matters is that they
  // count as owned, so an orphaned one stays visible.
  try {
    for (const pid of listTrackedProcessTrees()) {
      if (Number.isInteger(pid) && pid > 0) ownedPids.add(pid);
    }
  } catch {
    /* tracker unavailable — the other sources still stand */
  }

  return { labels, ownedPids: [...ownedPids] };
}
