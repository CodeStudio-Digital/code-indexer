/**
 * useApiClient — state + actions for one project's API client. Self-contained
 * (local React state, no global store) so two mounts (project tab + company
 * tab) never leak collections into each other.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from './api.js';
import type { ApiCollection, ApiEnvironment, ApiRequest, SendResponse } from './types.js';

export interface ApiClientState {
  collections: ApiCollection[];
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeCollectionId: number | null;
  activeRequestId: number | null;
  selectedEnvId: number | null;
  response: SendResponse | null;
  sending: boolean;
  error: string | null;
  loading: boolean;
}

const INITIAL_STATE: ApiClientState = {
  collections: [], requests: [], environments: [],
  activeCollectionId: null, activeRequestId: null, selectedEnvId: null,
  response: null, sending: false, error: null, loading: true,
};

export function useApiClient(projectId: number) {
  const [s, set] = useState<ApiClientState>(INITIAL_STATE);
  const patch = useCallback((p: Partial<ApiClientState>) => set((prev) => ({ ...prev, ...p })), []);

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
  }

  const refreshCollections = useCallback(async () => {
    const collections = await api.listCollections(projectId);
    set((prev) => ({
      ...prev,
      collections,
      activeCollectionId: prev.activeCollectionId ?? collections[0]?.id ?? null,
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
    set((prev) => ({ ...prev, requests }));
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

  const selectCollection = useCallback((id: number) =>
    patch({ activeCollectionId: id, activeRequestId: null, response: null }), [patch]);
  // Re-fetch the active collection's requests WITHOUT touching the current
  // selection/response — used after a regression run (which updates nothing on
  // the request rows, so resetting selection would just blank the editor).
  const reloadRequests = useCallback(() => {
    if (s.activeCollectionId != null) {
      refreshRequests(s.activeCollectionId).catch(() => { /* non-fatal */ });
    }
  }, [s.activeCollectionId, refreshRequests]);
  const selectRequest = useCallback((id: number) => patch({ activeRequestId: id, response: null }), [patch]);
  const selectEnv = useCallback((id: number) => patch({ selectedEnvId: id }), [patch]);

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
      const activeCollectionId = prev.activeCollectionId === cid ? collections[0]?.id ?? null : prev.activeCollectionId;
      return { ...prev, collections, activeCollectionId, activeRequestId: null };
    });
  }, [projectId]);

  const addRequest = useCallback(async (name: string, folder?: string) => {
    if (s.activeCollectionId == null) return;
    const r = await api.createRequest(projectId, s.activeCollectionId, { name, method: 'GET', folder: folder ?? null });
    await refreshRequests(s.activeCollectionId);
    patch({ activeRequestId: r.id });
  }, [projectId, s.activeCollectionId, refreshRequests, patch]);

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
    patch({ activeRequestId: r.id });
  }, [projectId, s.activeCollectionId, refreshRequests, patch]);

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
    await Promise.all(ids.map((id) => api.deleteRequest(projectId, id)));
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
    set((prev) => ({ ...prev, activeRequestId: prev.activeRequestId != null && ids.includes(prev.activeRequestId) ? null : prev.activeRequestId }));
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
    await api.deleteRequest(projectId, rid);
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
    set((prev) => ({ ...prev, activeRequestId: prev.activeRequestId === rid ? null : prev.activeRequestId }));
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const send = useCallback(async (rid: number) => {
    patch({ sending: true, error: null, response: null });
    try {
      const response = await api.sendRequest(projectId, rid, s.selectedEnvId ?? undefined);
      // Patch just the sent row's status in place — no full-collection refetch.
      set((prev) => ({
        ...prev,
        response,
        requests: prev.requests.map((r) => (r.id === rid ? { ...r, last_status: response.status, last_run_at: new Date().toISOString() } : r)),
      }));
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      patch({ sending: false });
    }
  }, [projectId, s.selectedEnvId, patch]);

  return {
    state: s,
    refreshEnvironments, refreshCollections, reloadRequests, removeEnvironment,
    selectCollection, selectRequest, selectEnv,
    addCollection, renameCollection, removeCollection,
    addRequest, saveRequest, removeRequest, verifyRequest,
    addFolder, renameFolder, removeFolder, moveRequest,
    duplicateRequest, reorderRequests, bulkMove, bulkDelete,
    send,
  };
}
