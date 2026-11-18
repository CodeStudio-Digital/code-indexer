/**
 * Lazy file-tree store (IntelliJ model): directories load on first expand
 * (`files.tree` depth=1 with hasChildren), live fs-events mutate the loaded
 * slices in place, and expansion + scroll persist per project. The view
 * flattens `children`+`expanded` into virtualized rows.
 */
import { create } from 'zustand';
import { apiCall } from '../lib/api-client.js';
import { createBoundedQueue } from './file-tree-loader.js';
import { useSelectionStore } from './file-tree-selection.js';

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  hasChildren?: boolean;
}

interface TreeNodeDTO extends TreeEntry { children?: TreeNodeDTO[] }
interface FsEventDTO { path: string; kind: 'upsert' | 'delete'; isDir: boolean }

const PERSIST_PREFIX = 'mcp-ide:file-tree:';
// 200 dirs expandidos já é um power-user extremo; com a fila bounded e a
// ordenação por profundidade, os visíveis chegam nas 1ªs waves.
const MAX_PERSISTED = 200;

// Concorrência do restore da árvore. Quatro leituras mantêm o Explorer ágil sem
// competir com o LSP/indexador durante a abertura. Ajustável em runtime via
// `window.__MCP_TREE_QUEUE_CONCURRENCY__` para medir (espelha __MCP_API_BASE__).
function treeQueueConcurrency(): number {
  const override =
    typeof window !== 'undefined'
      ? (window as unknown as { __MCP_TREE_QUEUE_CONCURRENCY__?: number }).__MCP_TREE_QUEUE_CONCURRENCY__
      : undefined;
  return typeof override === 'number' && override > 0 ? override : 4;
}

function createTreeLoad() {
  return {
    controller: new AbortController(),
    queue: createBoundedQueue(treeQueueConcurrency()),
    pending: new Map<string, Promise<void>>(),
  };
}
let treeLoad = createTreeLoad();

function resetTreeLoad(): void {
  treeLoad.queue.clear();
  treeLoad.controller.abort();
  treeLoad = createTreeLoad();
}

function restoreBranch(dir: string, get: () => FileTreeState, load = treeLoad): void {
  const { signal } = load.controller;
  load.queue.push(dir, dir ? dir.split('/').length : 0, async () => {
    for (let p = dir; p; p = parentOf(p)) {
      if (!get().expanded.has(p)) return;
    }
    if (signal.aborted) return;
    await get().ensureLoaded(dir);
    if (signal.aborted) return;
    const { children, expanded } = get();
    for (const child of children.get(dir) ?? []) {
      if (child.type === 'dir' && expanded.has(child.path)) restoreBranch(child.path, get, load);
    }
  });
}

function parentOf(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? '' : p.slice(0, ix);
}
function nameOf(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function loadPersisted(projectId: number): string[] {
  try {
    const raw = localStorage.getItem(`${PERSIST_PREFIX}${projectId}`);
    return raw ? (JSON.parse(raw) as string[]).slice(0, MAX_PERSISTED) : [];
  } catch { return []; }
}
function persist(projectId: number, expanded: Set<string>): void {
  try {
    localStorage.setItem(`${PERSIST_PREFIX}${projectId}`, JSON.stringify([...expanded].slice(0, MAX_PERSISTED)));
  } catch { /* quota — non-fatal */ }
}

interface FileTreeState {
  projectId: number | null;
  /** parentPath ('' = root) → sorted entries. Presence = loaded. */
  children: Map<string, TreeEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  error: string | null;
  /** Bumped on every mutation so memoized row flattening recomputes. */
  version: number;

  init: (projectId: number) => void;
  ensureLoaded: (dir: string) => Promise<void>;
  toggle: (dir: string) => void;
  /** Expand every ancestor of `path` (loading as needed). */
  reveal: (path: string) => Promise<void>;
  applyFsEvents: (events: FsEventDTO[]) => void;
  refresh: () => void;
}

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  projectId: null,
  children: new Map(),
  expanded: new Set(),
  loading: new Set(),
  error: null,
  version: 0,

  init: (projectId) => {
    const expanded = new Set(loadPersisted(projectId));
    resetTreeLoad();
    set({
      projectId,
      children: new Map(),
      expanded,
      loading: new Set(),
      error: null,
      version: 0,
    });
    restoreBranch('', get);
  },

  ensureLoaded: (dir) => {
    const { projectId, children } = get();
    if (projectId == null || children.has(dir)) return Promise.resolve();
    const { controller: { signal }, pending } = treeLoad;
    const existing = pending.get(dir);
    if (existing) return existing;
    set((s) => ({ loading: new Set(s.loading).add(dir) }));
    const request = apiCall<TreeNodeDTO>('files.tree', {
      projectId, root: dir === '' ? '.' : dir, maxDepth: 1,
    }, { signal }).then(node => {
      if (signal.aborted) return;
      const entries = (node.children ?? [])
        .map<TreeEntry>((c) => ({ name: c.name, path: c.path, type: c.type, hasChildren: c.hasChildren ?? (c.children?.length ?? 0) > 0 }))
        .sort(compareTreeEntries);
      set((s) => {
        const next = new Map(s.children);
        next.set(dir, entries);
        const loadingNext = new Set(s.loading);
        loadingNext.delete(dir);
        return { children: next, loading: loadingNext, error: null, version: s.version + 1 };
      });
    }).catch((err: unknown) => {
      if (signal.aborted) return;
      set((s) => {
        const loadingNext = new Set(s.loading);
        loadingNext.delete(dir);
        return { loading: loadingNext, error: err instanceof Error ? err.message : String(err) };
      });
    }).finally(() => pending.delete(dir));
    pending.set(dir, request);
    return request;
  },

  toggle: (dir) => {
    const { expanded, projectId } = get();
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    set((s) => ({ expanded: next, version: s.version + 1 }));
    if (next.has(dir)) restoreBranch(dir, get);
    if (projectId != null) persist(projectId, next);
  },

  reveal: async (path) => {
    const { signal } = treeLoad.controller;
    const ancestors: string[] = [];
    let dir = parentOf(path);
    while (dir) { ancestors.unshift(dir); dir = parentOf(dir); }
    for (const a of ['', ...ancestors]) {
      if (signal.aborted) return;
      await get().ensureLoaded(a);
    }
    if (signal.aborted) return;
    const opened = ancestors.filter(path => !get().expanded.has(path));
    set((s) => {
      const next = new Set(s.expanded);
      for (const a of ancestors) next.add(a);
      if (s.projectId != null) persist(s.projectId, next);
      return { expanded: next, version: s.version + 1 };
    });
    if (opened[0]) restoreBranch(opened[0], get);
  },

  applyFsEvents: (events) => {
    // A checkout can emit thousands of content changes in one batch. Only
    // membership changes in loaded directories affect the Explorer.
    const deleted = new Set(events.filter(e => e.kind === 'delete').map(e => e.path));
    if (deleted.size) useSelectionStore.getState().prune([...deleted]);
    set((s) => {
      const children = new Map(s.children);
      const expanded = new Set(s.expanded);
      const lists = new Map<string, Map<string, TreeEntry>>();
      const changedParents = new Set<string>();
      let touched = false;
      if (deleted.size) {
        for (const key of new Set([...children.keys(), ...expanded])) {
          for (let p = key; p; p = parentOf(p)) {
            if (!deleted.has(p)) continue;
            children.delete(key);
            expanded.delete(key);
            touched = true;
            break;
          }
        }
      }
      for (const e of events) {
        const parent = parentOf(e.path);
        const entries = children.get(parent);
        if (!entries) continue;
        let list = lists.get(parent);
        if (!list) {
          list = new Map(entries.map(entry => [entry.path, entry]));
          lists.set(parent, list);
        }
        if (e.kind === 'delete') {
          if (list.delete(e.path)) changedParents.add(parent);
        } else {
          const type = e.isDir ? 'dir' : 'file';
          if (list.get(e.path)?.type === type) continue;
          list.set(e.path, {
            name: nameOf(e.path), path: e.path,
            type,
            hasChildren: e.isDir ? true : undefined,
          });
          changedParents.add(parent);
        }
      }
      for (const parent of changedParents) children.set(parent, [...lists.get(parent)!.values()].sort(compareTreeEntries));
      return touched || changedParents.size ? { children, expanded, version: s.version + 1 } : {};
    });
  },

  refresh: () => {
    const { projectId } = get();
    if (projectId == null) return;
    resetTreeLoad();
    set((s) => ({ children: new Map(), loading: new Set(), error: null, version: s.version + 1 }));
    restoreBranch('', get);
  },
}));

/** Flatten loaded children + expansion into render rows (depth for indent). */
export function visibleRows(state: Pick<FileTreeState, 'children' | 'expanded'>): Array<{ entry: TreeEntry; depth: number }> {
  const out: Array<{ entry: TreeEntry; depth: number }> = [];
  const walk = (dir: string, depth: number): void => {
    const entries = state.children.get(dir);
    if (!entries) return;
    for (const entry of entries) {
      out.push({ entry, depth });
      if (entry.type === 'dir' && state.expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}
