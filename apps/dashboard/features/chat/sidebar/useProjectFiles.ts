import { useCallback, useEffect, useState } from 'react';

interface ProjectTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface ProjectTreeNode extends ProjectTreeEntry {
  children?: ProjectTreeNode[];
}

export interface SearchResult {
  path: string;
  type: 'file' | 'dir';
}

interface SearchState {
  query: string;
  results: SearchResult[];
  truncated: boolean;
  loading: boolean;
}

/**
 * Lazy-loading project file tree + search. Children are fetched on demand
 * when the user expands a directory; search results come from a separate
 * recursive endpoint and replace the tree view while active.
 */
export function useProjectFiles(projectId: number | null, sessionId?: string) {
  const scopeQuery = sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : '';
  const [root, setRoot] = useState<ProjectTreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Debounce the typed query so we don't fire requests on every keystroke.
  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(h);
  }, [search]);

  const fetchEntries = useCallback(
    async (path: string): Promise<ProjectTreeEntry[] | null> => {
      if (projectId == null) return null;
      try {
        const r = await fetch(
          `/api/coder/projects/${projectId}/tree?path=${encodeURIComponent(path)}${scopeQuery}`,
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const data = (await r.json()) as { mode: 'tree'; entries: ProjectTreeEntry[] };
        return data.entries;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [projectId, scopeQuery],
  );

  // Load the root listing on project change or manual reload.
  useEffect(() => {
    if (projectId == null) {
      setRoot(null);
      return;
    }
    let cancelled = false;
    setRoot(null);
    setError(null);
    fetchEntries('.').then((entries) => {
      if (cancelled || !entries) return;
      setRoot({
        name: '/',
        path: '.',
        type: 'dir',
        size: null,
        children: entries,
      });
      setExpanded(new Set(['.']));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey, fetchEntries]);

  // Run the search query whenever the debounced value changes.
  useEffect(() => {
    if (projectId == null || debouncedSearch.length < 2) {
      setSearchState(null);
      return;
    }
    let cancelled = false;
    setSearchState({ query: debouncedSearch, results: [], truncated: false, loading: true });
    fetch(`/api/coder/projects/${projectId}/tree?q=${encodeURIComponent(debouncedSearch)}${scopeQuery}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { entries: SearchResult[]; truncated: boolean }) => {
        if (cancelled) return;
        setSearchState({
          query: debouncedSearch,
          results: data.entries,
          truncated: data.truncated,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSearchState({ query: debouncedSearch, results: [], truncated: false, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, debouncedSearch, scopeQuery]);

  const toggleExpand = useCallback(
    async (node: ProjectTreeNode) => {
      const isOpen = expanded.has(node.path);
      const next = new Set(expanded);
      if (isOpen) {
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      next.add(node.path);
      setExpanded(next);
      if (node.children == null) {
        const entries = await fetchEntries(node.path);
        if (entries) {
          setRoot((prev) => (prev ? assignChildren(prev, node.path, entries) : prev));
        }
      }
    },
    [expanded, fetchEntries],
  );

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return {
    root,
    expanded,
    toggleExpand,
    error,
    search,
    setSearch,
    searchState,
    reload,
  };
}

function assignChildren(
  node: ProjectTreeNode,
  targetPath: string,
  children: ProjectTreeEntry[],
): ProjectTreeNode {
  if (node.path === targetPath) return { ...node, children };
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => assignChildren(c, targetPath, children)) };
}
