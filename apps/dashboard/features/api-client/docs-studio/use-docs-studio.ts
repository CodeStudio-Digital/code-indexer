/**
 * State + actions for the Docs Studio: loads the project's collections, the
 * active collection's requests + guide pages, and the assembled DocModel for the
 * live preview. Saves are debounced; the preview model is rebuilt after a save.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import * as docsApi from './docs-studio-api.js';
import type { ApiCollection, ApiDocPage, ApiRequest } from '../types.js';
import type { DocModel } from '../doc-shell/types.js';

interface DocsStudioState {
  collections: ApiCollection[];
  activeCollectionId: number | null;
  collection: ApiCollection | null;
  requests: ApiRequest[];
  pages: ApiDocPage[];
  model: DocModel | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: DocsStudioState = { collections: [], activeCollectionId: null, collection: null, requests: [], pages: [], model: null, loading: true, error: null };

export function useDocsStudio(projectId: number) {
  const [s, set] = useState<DocsStudioState>(INITIAL);
  const patch = useCallback((p: Partial<DocsStudioState>) => set((prev) => ({ ...prev, ...p })), []);

  const [tracked, setTracked] = useState(projectId);
  if (tracked !== projectId) { setTracked(projectId); set(INITIAL); }

  // Load + assemble the active collection's content + preview model.
  const loadCollection = useCallback(async (cid: number) => {
    const [requests, pages, model] = await Promise.all([
      api.listRequests(projectId, cid),
      docsApi.listDocPages(projectId, cid),
      docsApi.getDocModel(projectId, cid).catch(() => null),
    ]);
    set((prev) => (prev.activeCollectionId === cid
      ? { ...prev, requests, pages, model, collection: prev.collections.find((c) => c.id === cid) ?? prev.collection }
      : prev));
  }, [projectId]);

  // Rebuild only the preview model (after a save) — debounced.
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadModel = useCallback((cid: number) => {
    if (modelTimer.current) clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => {
      docsApi.getDocModel(projectId, cid).then((model) => set((prev) => (prev.activeCollectionId === cid ? { ...prev, model } : prev))).catch(() => { /* keep last */ });
    }, 350);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const collections = await api.listCollections(projectId);
        if (!alive) return;
        const activeCollectionId = collections[0]?.id ?? null;
        set((prev) => ({ ...prev, collections, activeCollectionId, collection: collections[0] ?? null, loading: false }));
        if (activeCollectionId != null) await loadCollection(activeCollectionId);
      } catch (e) {
        if (alive) patch({ error: e instanceof Error ? e.message : String(e), loading: false });
      }
    })();
    return () => { alive = false; };
  }, [projectId, loadCollection, patch]);

  const selectCollection = useCallback((id: number) => {
    set((prev) => ({ ...prev, activeCollectionId: id, collection: prev.collections.find((c) => c.id === id) ?? null, requests: [], pages: [], model: null }));
    loadCollection(id).catch((e) => patch({ error: e instanceof Error ? e.message : String(e) }));
  }, [loadCollection, patch]);

  const saveCollectionDocs = useCallback(async (body: docsApi.CollectionDocPatch) => {
    const cid = s.activeCollectionId;
    if (cid == null) return;
    set((prev) => ({ ...prev, collection: prev.collection ? { ...prev.collection, ...body } : prev.collection }));
    await docsApi.patchCollectionDocs(projectId, cid, body);
    reloadModel(cid);
  }, [projectId, s.activeCollectionId, reloadModel]);

  const saveRequestDoc = useCallback(async (rid: number, body: { description?: string; param_docs_json?: string }) => {
    set((prev) => ({ ...prev, requests: prev.requests.map((r) => (r.id === rid ? { ...r, ...body } : r)) }));
    await api.patchRequest(projectId, rid, body);
    if (s.activeCollectionId != null) reloadModel(s.activeCollectionId);
  }, [projectId, s.activeCollectionId, reloadModel]);

  const reloadPages = useCallback(async () => {
    const cid = s.activeCollectionId;
    if (cid == null) return;
    const pages = await docsApi.listDocPages(projectId, cid);
    set((prev) => ({ ...prev, pages }));
    reloadModel(cid);
  }, [projectId, s.activeCollectionId, reloadModel]);

  const createPage = useCallback(async (title: string) => {
    const cid = s.activeCollectionId;
    if (cid == null) return;
    await docsApi.createDocPage(projectId, cid, { title });
    await reloadPages();
  }, [projectId, s.activeCollectionId, reloadPages]);

  const updatePage = useCallback(async (pid: number, body: { title?: string; body_md?: string }) => {
    const cid = s.activeCollectionId;
    if (cid == null) return;
    set((prev) => ({ ...prev, pages: prev.pages.map((p) => (p.id === pid ? { ...p, ...body } : p)) }));
    await docsApi.updateDocPage(projectId, cid, pid, body);
    reloadModel(cid);
  }, [projectId, s.activeCollectionId, reloadModel]);

  const deletePage = useCallback(async (pid: number) => {
    const cid = s.activeCollectionId;
    if (cid == null) return;
    await docsApi.deleteDocPage(projectId, cid, pid);
    await reloadPages();
  }, [projectId, s.activeCollectionId, reloadPages]);

  return { state: s, selectCollection, saveCollectionDocs, saveRequestDoc, createPage, updatePage, deletePage, reloadPages };
}
