/**
 * useSpriteStudio — state + actions for one project's Sprite Studio. Master
 * hook mirroring features/api-client/useApiClient.ts: self-contained local
 * React state (no global store) plus the projectId-reset guard so switching
 * projects can never leak the previous project's selection into API calls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from './sprite-studio-ui-state.js';
import {
  CATEGORY_GROUPS,
  type AssetVersion, type CategoryGroupId, type SpriteAsset, type SpriteCategory,
  type SpriteProjectInfo, type StudioMode, type StudioSettings,
} from './types.js';

export interface SpriteStudioState {
  project: SpriteProjectInfo | null;
  settings: StudioSettings | null;
  assets: SpriteAsset[];
  /** Versions of the active asset (loaded by selectAsset). */
  versions: AssetVersion[];
  activeCategory: CategoryGroupId | 'all';
  activeAssetId: string | null;
  activeVersionId: string | null;
  mode: StudioMode;
  query: string;
  loading: boolean;
  error: string | null;
  /** Whether `<repo>/.sprite-studio/` exists for this project. */
  initialized: boolean;
}

const INITIAL_STATE: SpriteStudioState = {
  project: null, settings: null, assets: [], versions: [],
  activeCategory: 'all', activeAssetId: null, activeVersionId: null,
  mode: 'generate', query: '', loading: true, error: null, initialized: false,
};

function initialStateFor(projectId: number | null): SpriteStudioState {
  const persisted = projectId != null ? loadSpriteStudioUi(projectId) : null;
  // Export/animate are dialog/F2 surfaces — never restore them as the mode.
  const mode = persisted?.lastMode === 'edit' ? 'edit' : 'generate';
  return { ...INITIAL_STATE, mode, loading: projectId != null };
}

export function useSpriteStudio(projectId: number | null) {
  const [s, set] = useState<SpriteStudioState>(() => initialStateFor(projectId));
  const patch = useCallback((p: Partial<SpriteStudioState>) => set((prev) => ({ ...prev, ...p })), []);

  // Project-switch guard (render-time reset, same pattern as useApiClient):
  // asset/version ids are foreign row ids — a projectId change WITHOUT a
  // remount must drop the previous project's selection before any effect
  // runs, so no frame shows (or fetches against) stale ids.
  const [trackedProject, setTrackedProject] = useState(projectId);
  if (trackedProject !== projectId) {
    setTrackedProject(projectId);
    set(initialStateFor(projectId));
  }

  const refreshAssets = useCallback(async () => {
    if (projectId == null) return;
    const assets = await api.listAssets(projectId);
    set((prev) => ({ ...prev, assets }));
  }, [projectId]);

  // Initial load: get-or-check the sprite project, then its assets.
  useEffect(() => {
    if (projectId == null) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.getProject(projectId);
        if (!alive) return;
        patch({ initialized: res.initialized, project: res.project, settings: res.project?.settings ?? null });
        if (res.initialized) {
          const assets = await api.listAssets(projectId);
          if (alive) patch({ assets });
        }
      } catch (e) {
        if (alive) patch({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (alive) patch({ loading: false });
      }
    })();
    return () => { alive = false; };
  }, [projectId, patch]);

  /** Create `.sprite-studio/` for this project, then load its (empty) library. */
  const initStudio = useCallback(async () => {
    if (projectId == null) return;
    patch({ loading: true, error: null });
    try {
      const project = await api.initProject(projectId);
      patch({ initialized: true, project, settings: project.settings });
      await refreshAssets();
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      patch({ loading: false });
    }
  }, [projectId, patch, refreshAssets]);

  /** Select an asset and load its version history. */
  const selectAsset = useCallback(async (assetId: string | null) => {
    if (assetId == null) {
      patch({ activeAssetId: null, activeVersionId: null, versions: [] });
      return;
    }
    set((prev) => ({ ...prev, activeAssetId: assetId, versions: [], activeVersionId: null }));
    if (projectId == null) return;
    try {
      const versions = await api.listVersions(projectId, assetId);
      // Drop a late response if the selection moved on (fast click-through).
      set((prev) => {
        if (prev.activeAssetId !== assetId) return prev;
        const current = prev.assets.find((a) => a.id === assetId)?.currentVersionId ?? null;
        const activeVersionId = current ?? versions[versions.length - 1]?.id ?? null;
        return { ...prev, versions, activeVersionId };
      });
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e) });
    }
  }, [projectId, patch]);

  const selectVersion = useCallback((versionId: string | null) => patch({ activeVersionId: versionId }), [patch]);

  const setMode = useCallback((mode: StudioMode) => {
    patch({ mode });
    if (projectId != null) saveSpriteStudioUi(projectId, { lastMode: mode });
  }, [projectId, patch]);

  const setCategory = useCallback((activeCategory: CategoryGroupId | 'all') => patch({ activeCategory }), [patch]);
  const setQuery = useCallback((query: string) => patch({ query }), [patch]);

  const createAsset = useCallback(async (input: { name: string; category: SpriteCategory; width: number; height: number }) => {
    if (projectId == null) return null;
    const asset = await api.createAsset(projectId, input);
    await refreshAssets();
    void selectAsset(asset.id);
    return asset;
  }, [projectId, refreshAssets, selectAsset]);

  // Patch the single returned row in place (no full-library refetch on blur).
  const patchAsset = useCallback(async (assetId: string, p: Partial<SpriteAsset>) => {
    if (projectId == null) return;
    const updated = await api.patchAsset(projectId, assetId, p);
    set((prev) => ({ ...prev, assets: prev.assets.map((a) => (a.id === assetId ? updated : a)) }));
  }, [projectId]);

  const saveSettings = useCallback(async (settings: StudioSettings) => {
    if (projectId == null) return;
    const project = await api.putSettings(projectId, settings);
    patch({ project, settings: project.settings });
  }, [projectId, patch]);

  // Library list after the group filter + search query (counts in the tree
  // read the UNFILTERED `state.assets` so they stay stable while filtering).
  const filteredAssets = useMemo(() => {
    let rows = s.assets;
    if (s.activeCategory !== 'all') {
      const group = CATEGORY_GROUPS.find((g) => g.id === s.activeCategory);
      if (group) rows = rows.filter((a) => group.categories.includes(a.category));
    }
    const q = s.query.trim().toLowerCase();
    if (q) rows = rows.filter((a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)));
    return rows;
  }, [s.assets, s.activeCategory, s.query]);

  const activeAsset = useMemo(
    () => s.assets.find((a) => a.id === s.activeAssetId) ?? null,
    [s.assets, s.activeAssetId],
  );

  return {
    state: s,
    filteredAssets, activeAsset,
    initStudio, refreshAssets, selectAsset, selectVersion,
    setMode, setCategory, setQuery,
    createAsset, patchAsset, saveSettings,
  };
}
