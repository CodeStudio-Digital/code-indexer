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

export function useApiClient(projectId: number) {
  const [s, set] = useState<ApiClientState>({
    collections: [], requests: [], environments: [],
    activeCollectionId: null, activeRequestId: null, selectedEnvId: null,
    response: null, sending: false, error: null, loading: true,
  });
  const patch = useCallback((p: Partial<ApiClientState>) => set((prev) => ({ ...prev, ...p })), []);

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

  const removeCollection = useCallback(async (cid: number) => {
    await api.deleteCollection(projectId, cid);
    set((prev) => {
      const collections = prev.collections.filter((c) => c.id !== cid);
      const activeCollectionId = prev.activeCollectionId === cid ? collections[0]?.id ?? null : prev.activeCollectionId;
      return { ...prev, collections, activeCollectionId, activeRequestId: null };
    });
  }, [projectId]);

  const addRequest = useCallback(async (name: string) => {
    if (s.activeCollectionId == null) return;
    const r = await api.createRequest(projectId, s.activeCollectionId, { name, method: 'GET' });
    await refreshRequests(s.activeCollectionId);
    patch({ activeRequestId: r.id });
  }, [projectId, s.activeCollectionId, refreshRequests, patch]);

  const saveRequest = useCallback(async (rid: number, p: Partial<ApiRequest>) => {
    await api.patchRequest(projectId, rid, p);
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const verifyRequest = useCallback(async (rid: number, expectedStatus: number) => {
    await api.verifyRequest(projectId, rid, expectedStatus);
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const removeRequest = useCallback(async (rid: number) => {
    await api.deleteRequest(projectId, rid);
    if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
    set((prev) => ({ ...prev, activeRequestId: prev.activeRequestId === rid ? null : prev.activeRequestId }));
  }, [projectId, s.activeCollectionId, refreshRequests]);

  const send = useCallback(async (rid: number) => {
    patch({ sending: true, error: null, response: null });
    try {
      const response = await api.sendRequest(projectId, rid, s.selectedEnvId ?? undefined);
      patch({ response });
      if (s.activeCollectionId != null) await refreshRequests(s.activeCollectionId);
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      patch({ sending: false });
    }
  }, [projectId, s.selectedEnvId, s.activeCollectionId, refreshRequests, patch]);

  return {
    state: s,
    refreshEnvironments, refreshCollections, reloadRequests,
    selectCollection, selectRequest, selectEnv,
    addCollection, removeCollection,
    addRequest, saveRequest, removeRequest, verifyRequest,
    send,
  };
}
