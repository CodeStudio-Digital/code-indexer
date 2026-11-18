/**
 * useApiClient — state + actions for one project's API client. Self-contained
 * (local React state, no global store) so two mounts (project tab + company
 * tab) never leak collections into each other.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiRequest } from './types.js';
import * as api from './api.js';
import { useRequestRuns } from './use-request-runs.js';
import { loadApiClientUi, saveApiClientUi } from './api-client-ui-state.js';
import { parseRequestAssertion, requestRestoreCreateInput, requestRestorePatch } from './request-delete-undo.js';
import { type ApiClientState, INITIAL_STATE, closeTabState, removeTabsState, makeDraft } from './api-client-tab-state.js';

export function useApiClient(projectId: number) {
  const [s, set] = useState<ApiClientState>(INITIAL_STATE);
  const { runs, run, cancel, saveAs } = useRequestRuns(s.openTabIds);
  const activeRun = s.activeRequestId == null ? undefined : runs[s.activeRequestId];
  const [lastDeletedRequest, setLastDeletedRequest] = useState<{
    request: ApiRequest;
    wasOpen: boolean;
    wasActive: boolean;
  } | null>(null);
  const patch = useCallback((p: Partial<ApiClientState>) => set((prev) => ({ ...prev, ...p })), []);
  // The collection whose persisted tabs are currently loaded — gates the save
  // effect so a collection switch can't persist the OLD collection's tabs under
  // the new id before the load effect swaps them in.
  const loadedTabsRef = useRef<number | null>(null);

  // The hook is parametrized by projectId. Collection/request/env ids are
  // foreign row ids — a project switch (the projectId prop changes WITHOUT a
  // remount, both in ProjectView and the company tab) must DROP the previous
  // project's selection. Otherwise the refresh helpers below keep the stale
  // `selectedEnvId` (their `prev.selectedEnvId ?? default`), and a send hits
  // the OTHER project's environment base_url. Reset during render (React's
  // "a prop changed" pattern) so no frame shows the old project's env before
  // the load effect repopulates with this project's data.
  const [trackedProject, setTrackedProject] = useState(projectId);
  if (trackedProject !== projectId) {
    setTrackedProject(projectId);
    set(INITIAL_STATE);
    setLastDeletedRequest(null);
  }

  const refreshCollections = useCallback(async () => {
    const collections = await api.listCollections(projectId);
    set((prev) => ({
      ...prev,
      collections,
      activeCollectionId: prev.activeCollectionId ?? (prev.draftRequest ? null : collections[0]?.id ?? null),
    }));
  }, [projectId]);

  const refreshEnvironments = useCallback(async () => {
    const environments = await api.listEnvironments(projectId);
    set((prev) => ({
      ...prev,
      environments,
      selectedEnvId: prev.selectedEnvId
        ?? environments.find((e) => e.is_default)?.id
        ?? environments[0]?.id
        ?? null,
    }));
  }, [projectId]);

  const removeEnvironment = useCallback(async (eid: number) => {
    await api.deleteEnvironment(projectId, eid);
    set((prev) => ({ ...prev, selectedEnvId: prev.selectedEnvId === eid ? null : prev.selectedEnvId }));
    await refreshEnvironments();
  }, [projectId, refreshEnvironments]);

  const refreshRequests = useCallback(async (cid: number) => {
    const requests = await api.listRequests(projectId, cid);
    // Drop a late response whose collection is no longer active: fast switching
    // A→B (or A's slow fetch) must not clobber B's requests in the editor/list.
    set((prev) => {
      if (prev.activeCollectionId !== cid) return prev;
      // Reconcile open tabs against the freshly-loaded requests: drop ids whose
      // request no longer exists (deleted externally / stale persisted), keep the
      // draft (negative id), and fall back the active tab if it vanished.
      const valid = new Set(requests.map((r) => r.id));
      const openTabIds = prev.openTabIds.filter((id) => id < 0 || valid.has(id));
      let activeRequestId = prev.activeRequestId;
      if (activeRequestId != null && !openTabIds.includes(activeRequestId)) {
        activeRequestId = openTabIds[0] ?? null;
      }
      return { ...prev, requests, openTabIds, activeRequestId };
    });
  }, [projectId]);

  // Initial load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await Promise.all([refreshCollections(), refreshEnvironments()]);
      } catch (e) {
        if (alive) patch({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (alive) patch({ loading: false });
      }
    })();
    return () => { alive = false; };
  }, [refreshCollections, refreshEnvironments, patch]);

  // Load requests whenever the active collection changes.
  useEffect(() => {
    if (s.activeCollectionId == null) return;
    refreshRequests(s.activeCollectionId).catch((e) =>
      patch({ error: e instanceof Error ? e.message : String(e) }));
  }, [s.activeCollectionId, refreshRequests, patch]);

  // Load the persisted open tabs + active tab for the active collection. Once per
  // collection (ref-gated); refreshRequests then drops any ids whose request is gone.
  useEffect(() => {
    const cid = s.activeCollectionId;
    if (cid == null) { loadedTabsRef.current = null; return; }
    if (loadedTabsRef.current === cid) return;
    const persisted = loadApiClientUi(projectId, cid);
    loadedTabsRef.current = cid;
    set((prev) => (prev.activeCollectionId === cid
      ? { ...prev, openTabIds: persisted?.openTabIds ?? [], activeRequestId: persisted?.activeRequestId ?? null }
      : prev));
  }, [projectId, s.activeCollectionId]);

  // Persist the tab slice on change — but only AFTER this collection's tabs were
  // loaded (ref guard), so the switch frame (new id, old tabs) never overwrites.
  useEffect(() => {
    const cid = s.activeCollectionId;
    if (cid == null || loadedTabsRef.current !== cid) return;
    saveApiClientUi(projectId, cid, {
      openTabIds: s.openTabIds.filter((n) => n > 0),
      activeRequestId: s.activeRequestId != null && s.activeRequestId > 0
        ? s.activeRequestId
        : (s.openTabIds.find((n) => n > 0) ?? null),
    });
  }, [projectId, s.activeCollectionId, s.openTabIds, s.activeRequestId]);

  const selectCollection = useCallback((id: number) =>
    // Clear the visible tab set immediately so the bar never flashes the previous
    // collection's tabs; the tabs-load effect repopulates this collection's tabs.
    set(prev => prev.activeCollectionId === id ? prev : { ...prev, activeCollectionId: id, activeRequestId: null, openTabIds: [], draftRequest: null, draftDirty: false }), []);
  // Re-fetch the active collection's requests WITHOUT touching the current
  // selection/response — used after a regression run (which updates nothing on
  // the request rows, so resetting selection would just blank the editor).
  const reloadRequests = useCallback(() => {
    if (s.activeCollectionId != null) {
      refreshRequests(s.activeCollectionId).catch(() => { /* non-fatal */ });
    }
  }, [s.activeCollectionId, refreshRequests]);
  // Selecting a request = open-or-focus its tab (the draft, if open, stays as its
  // own tab — switching never discards it; only an explicit close does).
  const selectRequest = useCallback((id: number) => set((prev) => ({
    ...prev,
    openTabIds: prev.openTabIds.includes(id) ? prev.openTabIds : [...prev.openTabIds, id],
    activeRequestId: id,
  })), []);
  const selectEnv = useCallback((id: number) => patch({ selectedEnvId: id }), [patch]);
  /** Close a request/draft tab (X / middle-click), activating the neighbor. */
  const closeTab = useCallback((id: number) => set((prev) => closeTabState(prev, id)), []);
  /** Context-menu bulk closes — keep `id` focused (it survives), close the rest in scope. */
  const closeOtherTabs = useCallback((id: number) =>
    set((prev) => removeTabsState(prev, new Set(prev.openTabIds.filter((x) => x !== id)), id)), []);
  const closeTabsToRight = useCallback((id: number) =>
    set((prev) => {
      const idx = prev.openTabIds.indexOf(id);
      return idx < 0 ? prev : removeTabsState(prev, new Set(prev.openTabIds.slice(idx + 1)), id);
    }), []);
  const closeTabsToLeft = useCallback((id: number) =>
    set((prev) => {
      const idx = prev.openTabIds.indexOf(id);
      return idx < 0 ? prev : removeTabsState(prev, new Set(prev.openTabIds.slice(0, idx)), id);
    }), []);
  const closeAllTabs = useCallback(() =>
    set((prev) => removeTabsState(prev, new Set(prev.openTabIds), null)), []);

  // ─── Draft (unsaved Untitled request) — it is just another tab ────────
  const newDraft = useCallback(() => set((prev) => {
    // One draft at a time: focus the existing draft tab if there is one.
    const existing = prev.openTabIds.find((id) => id < 0);
    if (existing != null && prev.draftRequest) return { ...prev, activeRequestId: existing };
    const draft = makeDraft();
    return {
      ...prev,
      draftRequest: draft, draftDirty: false,
      openTabIds: [...prev.openTabIds.filter((id) => id >= 0), draft.id],
      activeRequestId: draft.id,
    };
  }), []);
  const updateDraft = useCallback((p: Partial<ApiRequest>) =>
    set((prev) => (prev.draftRequest ? { ...prev, draftRequest: { ...prev.draftRequest, ...p }, draftDirty: true } : prev)), []);
  // Discard = close the draft's tab (clears the draft, activates the neighbor).
  const discardDraft = useCallback(() => set((prev) => (prev.draftRequest ? closeTabState(prev, prev.draftRequest.id) : prev)), []);

  const addCollection = useCallback(async (name: string) => {
    const col = await api.createCollection(projectId, name);
    await refreshCollections();
    patch({ activeCollectionId: col.id });
  }, [projectId, refreshCollections, patch]);

  const renameCollection = useCallback(async (cid: number, name: string) => {
    await api.patchCollection(projectId, cid, { name });
    await refreshCollections();
  }, [projectId, refreshCollections]);

  const removeCollection = useCallback(async (cid: number) => {
    await api.deleteCollection(projectId, cid);
    set((prev) => {
      const collections = prev.collections.filter((c) => c.id !== cid);
      const switched = prev.activeCollectionId === cid;
      const activeCollectionId = switched ? collections[0]?.id ?? null : prev.activeCollectionId;
      // If the active collection was deleted, clear its tabs — the tabs-load effect
      // repopulates for the new active collection.
      return switched
        ? { ...prev, collections, activeCollectionId, activeRequestId: null, openTabIds: [], draftRequest: null, draftDirty: false }
        : { ...prev, collections };
    });
  }, [projectId]);

  const addRequest = useCallback(async (name: string, folder?: string) => {
    if (s.activeCollectionId == null) return;
    const r = await api.createRequest(projectId, s.activeCollectionId, { name, method: 'GET', folder: folder ?? null });
    await refreshRequests(s.activeCollectionId);
    set((prev) => ({ ...prev, openTabIds: prev.openTabIds.includes(r.id) ? prev.openTabIds : [...prev.openTabIds, r.id], activeRequestId: r.id }));
  }, [projectId, s.activeCollectionId, refreshRequests]);

  // ─── Folders ───────────────────────────────────────────────────────
  const addFolder = useCallback(async (name: string) => {
    if (s.activeCollectionId == null) return;
    await api.addFolder(projectId, s.activeCollectionId, name);
    await refreshCollections();
  }, [projectId, s.activeCollectionId, refreshCollections]);

  const renameFolder = useCallback(async (from: string, to: string) => {
    if (s.activeCollectionId == null) return;
    await api.renameFolder(projectId, s.activeCollectionId, from, to);
    await Promise.all([refreshCollections(), refreshRequests(s.activeCollectionId)]);
  }, [projectId, s.activeCollectionId, refreshCollections, refreshRequests]);

  const removeFolder = useCallback(async (name: string) => {
    if (s.activeCollectionId == null) return;
    await api.deleteFolder(projectId, s.activeCollectionId, name);
    await Promise.all([refreshCollections(), refreshRequests(s.activeCollectionId)]);
  }, [projectId, s.activeCollectionId, refreshCollections, refreshRequests]);

  const moveRequest = useCallback(async (rid: number, folder: string | null) => {
    await api.patchRequest(projectId, rid, { folder });
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const duplicateRequest = useCallback(async (rid: number) => {
    const r = await api.duplicateRequest(projectId, rid);
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
    set((prev) => ({ ...prev, openTabIds: prev.openTabIds.includes(r.id) ? prev.openTabIds : [...prev.openTabIds, r.id], activeRequestId: r.id }));
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const reorderRequests = useCallback(async (orderedIds: number[], folder: string | null) => {
    if (s.activeCollectionId == null) return;
    await api.reorderRequests(projectId, s.activeCollectionId, orderedIds, folder);
    await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  // Bulk ops — fan out then refresh once (cheaper than per-item refresh).
  const bulkMove = useCallback(async (ids: number[], folder: string | null) => {
    await Promise.all(ids.map((id) => api.patchRequest(projectId, id, { folder })));
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const bulkDelete = useCallback(async (ids: number[]) => {
    // Bulk deletion has its own explicit "cannot be undone" confirmation.
    // Do not leave an older single-delete undo looking like it applies here.
    setLastDeletedRequest(null);
    await Promise.all(ids.map((id) => api.deleteRequest(projectId, id)));
    set((prev) => {
      const gone = new Set(ids);
      const openTabIds = prev.openTabIds.filter((id) => !gone.has(id));
      let activeRequestId = prev.activeRequestId;
      if (activeRequestId != null && gone.has(activeRequestId)) activeRequestId = openTabIds[0] ?? null;
      return { ...prev, openTabIds, activeRequestId };
    });
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  // Patch the single returned row in place instead of refetching the whole
  // collection (SELECT * + re-hydrate of every row) on every field blur.
  const saveRequest = useCallback(async (rid: number, p: Partial<ApiRequest>) => {
    const updated = await api.patchRequest(projectId, rid, p);
    set((prev) => ({ ...prev, requests: prev.requests.map((r) => (r.id === rid ? updated : r)) }));
  }, [projectId]);

  const verifyRequest = useCallback(async (rid: number, expectedStatus: number) => {
    const updated = await api.verifyRequest(projectId, rid, expectedStatus);
    set((prev) => ({ ...prev, requests: prev.requests.map((r) => (r.id === rid ? updated : r)) }));
  }, [projectId]);

  const removeRequest = useCallback(async (rid: number) => {
    const request = s.requests.find((candidate) => candidate.id === rid) ?? null;
    await api.deleteRequest(projectId, rid);
    if (request) {
      setLastDeletedRequest({
        request,
        wasOpen: s.openTabIds.includes(rid),
        wasActive: s.activeRequestId === rid,
      });
    }
    // Reflect the successful delete immediately. A refetch failure must not leave
    // the deleted row visible or turn a completed delete into an error toast.
    set((prev) => closeTabState({
      ...prev,
      requests: prev.requests.filter((candidate) => candidate.id !== rid),
    }, rid));
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId).catch(() => undefined);
  }, [projectId, s.requests, s.openTabIds, s.activeRequestId, s.activeCollectionId, refreshRequests]);

  const undoLastRequestDelete = useCallback(async (): Promise<ApiRequest | null> => {
    const deleted = lastDeletedRequest;
    if (!deleted) return null;

    let restored: ApiRequest | null = null;
    try {
      restored = await api.createRequest(
        projectId,
        deleted.request.collection_id,
        requestRestoreCreateInput(deleted.request),
      );
      await api.patchRequest(projectId, restored.id, requestRestorePatch(deleted.request));
      if (deleted.request.verified && deleted.request.expected_status != null) {
        await api.verifyRequest(
          projectId,
          restored.id,
          deleted.request.expected_status,
          parseRequestAssertion(deleted.request.assert_json),
        );
      }
    } catch (error) {
      // Keep the undo snapshot retryable and compensate a partial recreation so
      // a second Ctrl+Z cannot produce duplicate requests.
      if (restored) await api.deleteRequest(projectId, restored.id).catch(() => undefined);
      throw error;
    }

    setLastDeletedRequest(null);
    if (s.activeCollectionId === deleted.request.collection_id) {
      await refreshRequests(deleted.request.collection_id).catch(() => undefined);
      set((prev) => {
        const requests = prev.requests.some((candidate) => candidate.id === restored.id)
          ? prev.requests
          : [...prev.requests, restored];
        const openTabIds = deleted.wasOpen && !prev.openTabIds.includes(restored.id)
          ? [...prev.openTabIds, restored.id]
          : prev.openTabIds;
        return {
          ...prev,
          requests,
          openTabIds,
          activeRequestId: deleted.wasActive ? restored.id : prev.activeRequestId,
        };
      });
    }
    return restored;
  }, [lastDeletedRequest, projectId, s.activeCollectionId, refreshRequests]);

  const send = useCallback(async (draft: ApiRequest) => {
    const rid = draft.id;
    const envId = s.selectedEnvId ?? undefined;
    const response = await run(rid, async signal => {
      if (rid < 0) return api.sendAdhoc(projectId, draft, envId, signal);
      await saveRequest(rid, draft);
      signal.throwIfAborted();
      return api.sendRequest(projectId, rid, envId, signal);
    });
    if (!response) return;
    if (rid > 0) set(prev => ({
      ...prev,
      requests: prev.requests.map(r => r.id === rid
        ? { ...r, last_status: response.status, last_run_at: new Date().toISOString() } : r),
    }));
    if (response.envUpdated) await refreshEnvironments().catch(() => {});
  }, [projectId, s.selectedEnvId, run, saveRequest, refreshEnvironments]);

  const openRequestInCollection = useCallback(async (cid: number, rid: number, draftId?: number) => {
    const [collections, requests] = await Promise.all([api.listCollections(projectId), api.listRequests(projectId, cid)]);
    const restored = loadApiClientUi(projectId, cid)?.openTabIds ?? [];
    loadedTabsRef.current = cid;
    if (draftId != null) saveAs(draftId, rid);
    set(prev => {
      const same = prev.activeCollectionId === cid;
      const tabs = same ? prev.openTabIds : restored;
      const openTabIds = [...new Set([...tabs.map(id => id === draftId ? rid : id), rid])];
      return { ...prev, collections, requests, activeCollectionId: cid, activeRequestId: rid, openTabIds,
        ...(same && draftId == null ? {} : { draftRequest: null, draftDirty: false }) };
    });
  }, [projectId, saveAs]);

  const saveDraft = useCallback(async (draft: ApiRequest, cid: number, folder: string | null, name: string) => {
    const created = await api.createRequest(projectId, cid, { ...draft, id: undefined, name, folder, source: 'manual' });
    await openRequestInCollection(cid, created.id, draft.id);
  }, [projectId, openRequestInCollection]);

  return {
    state: {
      ...s, response: activeRun?.response ?? null, previousResponse: activeRun?.previous ?? null,
      sending: activeRun?.sending ?? false, error: activeRun ? activeRun.error ?? null : s.error, cancelled: activeRun?.cancelled ?? false,
    },
    refreshEnvironments, refreshCollections, reloadRequests, removeEnvironment,
    selectCollection, selectRequest, selectEnv, closeTab,
    closeOtherTabs, closeTabsToRight, closeTabsToLeft, closeAllTabs,
    addCollection, renameCollection, removeCollection,
    addRequest, saveRequest, removeRequest, verifyRequest,
    canUndoRequestDelete: lastDeletedRequest != null,
    undoLastRequestDelete,
    addFolder, renameFolder, removeFolder, moveRequest,
    duplicateRequest, reorderRequests, bulkMove, bulkDelete,
    newDraft, updateDraft, discardDraft, saveDraft, send, cancel, openRequestInCollection,
  };
}
