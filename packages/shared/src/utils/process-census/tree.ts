/**
 * Build the app's process subtree out of a flat census frame.
 *
 * The task manager deliberately shows only CodeStudio's own processes, so the
 * frame (which holds every process on the machine) is walked from the main
 * pid down through PPID links. Grandchildren come for free: a terminal's
 * `npm run dev` → vite → esbuild chain is just three more descendants.
 *
 * Two traps this guards against:
 *
 *  - **PID reuse.** Windows recycles pids aggressively. Once a parent dies its
 *    pid can be handed to an unrelated process, whose children would then be
 *    adopted into our tree — `explorer.exe` showing up under the IDE. A child
 *    can never predate its parent, so a start time earlier than the parent's
 *    disproves the link.
 *  - **PPID cycles.** Recycling can also produce A→B→A. The visited set makes
 *    the walk terminate regardless of what the OS reports.
 */
import type { RawProcessRow } from './types.js';

/** Slack for the "a child cannot predate its parent" check (POSIX `etime` has
 *  one-second resolution, so a genuine child can appear ~1s older). */
const START_ORDER_TOLERANCE_MS = 1_500;

export interface CensusTreeNode {
  row: RawProcessRow;
  /** 0 for the main process and for each adopted orphan root. */
  depth: number;
  /** True when this subtree hangs off an adopted root rather than the main
   *  process — i.e. the parent that spawned it is already gone. */
  orphaned: boolean;
}

export interface CensusTree {
  /** Depth-first, stable across frames: children sort by memory desc, pid asc. */
  ordered: CensusTreeNode[];
  /** Every pid in `ordered`. The kill guard uses it to refuse foreign pids. */
  descendants: Set<number>;
}

function plausibleChild(parent: RawProcessRow, child: RawProcessRow): boolean {
  if (parent.createdAtMs === 0 || child.createdAtMs === 0) return true;
  return child.createdAtMs >= parent.createdAtMs - START_ORDER_TOLERANCE_MS;
}

/**
 * @param rows          every process in the frame
 * @param rootPid       the app's main process
 * @param extraRootPids pids the app still owns whose parent already died
 *                      (from the terminal/LSP/tracked-tree registries) — each
 *                      becomes an adopted root so leaked dev servers stay
 *                      visible and killable instead of silently vanishing.
 */
export function buildDescendantTree(
  rows: readonly RawProcessRow[],
  rootPid: number,
  extraRootPids: Iterable<number> = [],
): CensusTree {
  const byPid = new Map<number, RawProcessRow>();
  const childrenByPpid = new Map<number, RawProcessRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  for (const siblings of childrenByPpid.values()) {
    siblings.sort((a, b) => b.workingSetBytes - a.workingSetBytes || a.pid - b.pid);
  }

  const ordered: CensusTreeNode[] = [];
  const visited = new Set<number>();

  const walk = (row: RawProcessRow, depth: number, orphaned: boolean): void => {
    if (visited.has(row.pid)) return;
    visited.add(row.pid);
    ordered.push({ row, depth, orphaned });
    for (const child of childrenByPpid.get(row.pid) ?? []) {
      if (plausibleChild(row, child)) walk(child, depth + 1, orphaned);
    }
  };

  const root = byPid.get(rootPid);
  if (root) walk(root, 0, false);

  // Adopted roots come after the main tree, sorted the same way so the panel
  // does not reshuffle its "orphans" block between polls.
  const adopted = [...new Set(extraRootPids)]
    .map((pid) => byPid.get(pid))
    .filter((row): row is RawProcessRow => row != null && !visited.has(row.pid))
    .sort((a, b) => b.workingSetBytes - a.workingSetBytes || a.pid - b.pid);
  for (const row of adopted) walk(row, 0, true);

  return { ordered, descendants: visited };
}
