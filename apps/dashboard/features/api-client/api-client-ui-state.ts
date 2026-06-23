/**
 * Per-(project, collection) UI state for the API client, persisted to
 * localStorage so folder-collapse + open request tabs survive navigation and app
 * restarts. Two owners write DISJOINT slices — CollectionList writes the collapse
 * slice (collapsed/topCollapsed/seen); useApiClient writes the tab slice
 * (openTabIds/activeRequestId) — via a merge read-modify-write so neither
 * clobbers the other. Key convention mirrors state/workspace-layout.ts.
 */
export interface ApiClientUiState {
  /** Folder names that are collapsed. */
  collapsed: string[];
  /** Whether the implicit "Top level" group is collapsed. */
  topCollapsed: boolean;
  /** Folder names known at last save — a folder NOT in here is treated as new → collapsed. */
  seen: string[];
  /** Open request tabs (SAVED request ids only; the ephemeral draft is never persisted). */
  openTabIds: number[];
  /** The active tab (a saved request id), or null. */
  activeRequestId: number | null;
}

const DEFAULTS: ApiClientUiState = { collapsed: [], topCollapsed: false, seen: [], openTabIds: [], activeRequestId: null };

const keyFor = (projectId: number, collectionId: number): string => `mcp-ide:api-client-ui:${projectId}:${collectionId}`;

/** Read the persisted entry, or null when none exists (so callers can apply the "default collapsed" rule). */
export function loadApiClientUi(projectId: number, collectionId: number): ApiClientUiState | null {
  if (typeof window === 'undefined' || !Number.isFinite(collectionId)) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(projectId, collectionId));
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<ApiClientUiState>;
    return {
      collapsed: Array.isArray(o.collapsed) ? o.collapsed.filter((x): x is string => typeof x === 'string') : [],
      topCollapsed: !!o.topCollapsed,
      seen: Array.isArray(o.seen) ? o.seen.filter((x): x is string => typeof x === 'string') : [],
      // Defensive: only positive ids persist (drafts use negative synthetic ids).
      openTabIds: Array.isArray(o.openTabIds) ? o.openTabIds.filter((n): n is number => typeof n === 'number' && n > 0) : [],
      activeRequestId: typeof o.activeRequestId === 'number' ? o.activeRequestId : null,
    };
  } catch {
    return null;
  }
}

/** Merge a partial slice into the persisted entry (read-modify-write so the two owners don't clobber). */
export function saveApiClientUi(projectId: number, collectionId: number, slice: Partial<ApiClientUiState>): void {
  if (typeof window === 'undefined' || !Number.isFinite(collectionId)) return;
  try {
    const cur = loadApiClientUi(projectId, collectionId) ?? DEFAULTS;
    window.localStorage.setItem(keyFor(projectId, collectionId), JSON.stringify({ ...cur, ...slice }));
  } catch {
    /* quota / disabled — drop silently */
  }
}
