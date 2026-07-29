/**
 * Client-side sorting for the SFTP panes.
 *
 * WHY client-side: the listing is already in memory, so sorting is
 * sub-millisecond at any realistic size and a header click costs no round-trip.
 * The SERVER sort stays as-is (dirs-first + name) — it is the contract every
 * other consumer of `files.tree` relies on (the FileTreeRail among them) and it
 * gives a sane first paint before the user touches anything.
 *
 * WHY bi-state and not tri-state: a third "unsorted" state would be
 * indistinguishable from "name ascending", because that IS the order the server
 * already returns. An invisible state is a bug generator, not a feature.
 *
 * WHY dirs always come first: Explorer, Finder, FileZilla and WinSCP all do it,
 * and a listing where a folder can hide between two files is much harder to
 * scan. It is an invariant of every sort, not a user-toggleable option.
 */
import type { FsItem } from './fs-adapter.js';

export type SortKey = 'name' | 'size' | 'modified' | 'permissions' | 'owner' | 'group';
export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: 'name', dir: 'asc' };

const STORAGE_KEY = 'mcp-sftp:sort';

/**
 * Click behaviour: clicking the active column flips direction; clicking a
 * different column switches to it, ascending. (Ascending-first matches every
 * file manager: names A→Z, but note that for a fresh `size`/`modified` click
 * users often want the largest/newest — that is one extra click, and a
 * key-dependent default direction is more surprising than it is helpful.)
 */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: 'asc' };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * Natural-order name compare: `file9` before `file10`, unlike the plain
 * `localeCompare` the server uses (which puts `file10` first).
 */
const byName = (a: FsItem, b: FsItem): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function compareBy(key: SortKey, a: FsItem, b: FsItem): number {
  switch (key) {
    case 'size':
      // Directories have no meaningful size; keep them in name order among themselves.
      return (a.size ?? 0) - (b.size ?? 0);
    case 'modified':
      return (a.mtime ?? 0) - (b.mtime ?? 0);
    case 'permissions':
      return (a.mode ?? 0) - (b.mode ?? 0);
    // Sort on the DISPLAYED value, so `root` and `www-data` group the way the
    // user sees them rather than by the numeric id behind the name.
    case 'owner':
      return (a.owner ?? String(a.uid ?? '')).localeCompare(b.owner ?? String(b.uid ?? ''));
    case 'group':
      return (a.group ?? String(a.gid ?? '')).localeCompare(b.group ?? String(b.gid ?? ''));
    case 'name':
    default:
      return byName(a, b);
  }
}

/**
 * Sort a listing. Returns a NEW array (never mutates the caller's).
 * Directories always lead; ties break on name ascending so the order is stable
 * and a shift-range selection can't jump between renders.
 */
export function sortEntries(entries: FsItem[], sort: SortState): FsItem[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'dir';
    const bDir = b.type === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1; // invariant, independent of direction
    const primary = compareBy(sort.key, a, b) * sign;
    return primary !== 0 ? primary : byName(a, b);
  });
}

function isSortKey(v: unknown): v is SortKey {
  return v === 'name' || v === 'size' || v === 'modified' || v === 'permissions';
}

/** Read the persisted sort, falling back to the default on anything unexpected. */
export function loadSort(): SortState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<SortState>;
    return {
      key: isSortKey(parsed.key) ? parsed.key : DEFAULT_SORT.key,
      dir: parsed.dir === 'desc' ? 'desc' : 'asc',
    };
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSort(sort: SortState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sort));
  } catch {
    /* localStorage blocked / unavailable — in-memory only */
  }
}
