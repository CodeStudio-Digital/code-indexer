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
// Identical concurrent dir loads já colapsam no `dedupeInflight` de files.tree.
function treeQueueConcurrency(): number {
  const override =
    typeof window !== 'undefined'
      ? (window as unknown as { __MCP_TREE_QUEUE_CONCURRENCY__?: number }).__MCP_TREE_QUEUE_CONCURRENCY__
      : undefined;
  return typeof override === 'number' && override > 0 ? override : 4;
}

// Fila ÚNICA do restore da árvore (W2): cap de concorrência mata o thundering herd.
const loaderQueue = createBoundedQueue(treeQueueConcurrency());

/** Enfileira o restore (root + dirs persistidos, rasos primeiro) na fila bounded. */
function queueTreeRestore(expanded: Set<string>, load: (dir: string) => Promise<void>): void {
  const depthOf = (p: string): number => (p === '' ? 0 : p.split('/').length);
  const persisted = [...expanded].sort((a, b) => depthOf(a) - depthOf(b));
  // Root first: do not spend all slots restoring invisible old expansions
  // before the user can see the project at all.
  loaderQueue.push('', 0, async () => {
    await load('');
    for (const dir of persisted) {
      loaderQueue.push(dir, depthOf(dir) + 1, () => load(dir));
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
    loaderQueue.clear(); // cancela o restore do projeto anterior
    set({
      projectId,
      children: new Map(),
      expanded,
      loading: new Set(),
      error: null,
      version: 0,
    });
    // Root + dirs persistidos por uma fila BOUNDED ordenada por profundidade (rasos
    // primeiro). Substitui o fan-out paralelo de até 500 readdirs que travava a
    // abertura. O guard de projectId em ensureLoaded dropa resultados stale.
    queueTreeRestore(expanded, (dir) => get().ensureLoaded(dir));
  },

  ensureLoaded: async (dir) => {
    const { projectId, children, loading } = get();
    if (projectId == null || children.has(dir) || loading.has(dir)) return;
    set((s) => ({ loading: new Set(s.loading).add(dir) }));
    try {
      const node = await apiCall<TreeNodeDTO>('files.tree', {
        projectId, root: dir === '' ? '.' : dir, maxDepth: 1,
      });
      const entries = (node.children ?? [])
        .map<TreeEntry>((c) => ({ name: c.name, path: c.path, type: c.type, hasChildren: c.hasChildren ?? (c.children?.length ?? 0) > 0 }))
        .sort(compareTreeEntries);
      set((s) => {
        if (s.projectId !== projectId) return {};
        const next = new Map(s.children);
        next.set(dir, entries);
        const loadingNext = new Set(s.loading);
        loadingNext.delete(dir);
        return { children: next, loading: loadingNext, error: null, version: s.version + 1 };
      });
    } catch (err) {
      set((s) => {
        const loadingNext = new Set(s.loading);
        loadingNext.delete(dir);
        return { loading: loadingNext, error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  toggle: (dir) => {
    const { expanded, projectId } = get();
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      void get().ensureLoaded(dir);
    }
    set((s) => ({ expanded: next, version: s.version + 1 }));
    if (projectId != null) persist(projectId, next);
  },

  reveal: async (path) => {
    // Captura o projeto no início e reconfere no set final (espelha ensureLoaded).
    // Sem isso, um reveal em voo do projeto A — após a troca para B (init resetou
    // `expanded`) — adicionaria ancestrais de A ao set de B e os persistiria no
    // localStorage de B. O await abaixo cede o event loop, abrindo essa janela.
    const pid = get().projectId;
    const ancestors: string[] = [];
    let dir = parentOf(path);
    while (dir) { ancestors.unshift(dir); dir = parentOf(dir); }
    for (const a of ['', ...ancestors]) await get().ensureLoaded(a);
    set((s) => {
      if (s.projectId !== pid) return {};   // trocou de projeto mid-reveal → no-op
      const next = new Set(s.expanded);
      for (const a of ancestors) next.add(a);
      if (s.projectId != null) persist(s.projectId, next);
      return { expanded: next, version: s.version + 1 };
    });
  },

  applyFsEvents: (events) => {
    if (events.length > 500) { get().refresh(); return; }
    // Poda a seleção quando um path some do disco (delete externo OU nosso).
    const deleted = events.filter((e) => e.kind === 'delete').map((e) => e.path);
    if (deleted.length) useSelectionStore.getState().prune(deleted);
    set((s) => {
      const children = new Map(s.children);
      const expanded = new Set(s.expanded);
      let touched = false;
      for (const e of events) {
        const parent = parentOf(e.path);
        if (e.kind === 'delete') {
          // Drop the entry from its parent (if loaded) + every loaded slice
          // and expansion under it (dir subtree cleanup).
          const list = children.get(parent);
          if (list?.some((x) => x.path === e.path)) {
            children.set(parent, list.filter((x) => x.path !== e.path));
            touched = true;
          }
          for (const key of [...children.keys()]) {
            if (key === e.path || key.startsWith(`${e.path}/`)) { children.delete(key); touched = true; }
          }
          for (const key of [...expanded]) {
            if (key === e.path || key.startsWith(`${e.path}/`)) { expanded.delete(key); touched = true; }
          }
        } else {
          const list = children.get(parent);
          if (!list) continue; // parent not loaded — will appear on expand
          if (list.some((x) => x.path === e.path)) continue; // content change, not creation
          const entry: TreeEntry = {
            name: nameOf(e.path), path: e.path,
            type: e.isDir ? 'dir' : 'file',
            // Optimistic chevron, matching the tree handler's fast path.
            hasChildren: e.isDir ? true : undefined,
          };
          const next = [...list, entry].sort(compareTreeEntries);
          children.set(parent, next);
          touched = true;
        }
      }
      return touched ? { children, expanded, version: s.version + 1 } : {};
    });
  },

  refresh: () => {
    const { projectId, expanded } = get();
    if (projectId == null) return;
    loaderQueue.clear();
    set((s) => ({ children: new Map(), loading: new Set(), version: s.version + 1 }));
    queueTreeRestore(expanded, (dir) => get().ensureLoaded(dir));
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
