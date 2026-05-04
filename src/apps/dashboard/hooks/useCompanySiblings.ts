/**
 * Multi-front (sub-session) tab list for a company session.
 *
 * Migration 067 models each tab as a full `CompanySession` with
 * `parent_session_id` pointing to the root session. This hook drives
 * the tab bar:
 *   - `parent` is the root (the "Main" tab is the parent itself).
 *   - `children` are the active sub-sessions, ordered by id.
 *   - `activeSessionId` mirrors the user's selected tab and is
 *     persisted per parent in `localStorage[company-active-subsession:N]`.
 *
 * The hook does NOT subscribe to SSE here — sub-sessions each have
 * their own metaBus, and the dashboard mounts `useCompanyStream` on
 * the active tab's id to consume that one. We refresh the children
 * list lazily on action (create/rename/archive) and on demand.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CompanySession } from '../../../core/coder/company/types.js';

export interface SubSessionsState {
  parent: CompanySession | null;
  children: CompanySession[];
  loading: boolean;
  /** Persisted: active tab id; defaults to the parent's id (the Main tab). */
  activeSessionId: number | null;
}

const STORAGE_KEY = (rootId: number) => `company-active-subsession:${rootId}`;

export function useCompanySiblings(rootSessionId: number | null) {
  const [state, setState] = useState<SubSessionsState>({
    parent: null,
    children: [],
    loading: false,
    activeSessionId: null,
  });

  const refresh = useCallback(async () => {
    if (rootSessionId == null) return;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch(`/api/company/sessions/${rootSessionId}/children`);
      if (!res.ok) {
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
      const body = (await res.json()) as { parent: CompanySession; children: CompanySession[] };
      const parentId = body.parent.id;

      // Read persisted selection. Validate against the freshly-loaded
      // children + parent so a deleted tab doesn't leave us pointing at
      // a ghost.
      let persisted: number | null = null;
      if (typeof window !== 'undefined') {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY(parentId));
          if (raw) persisted = Number(raw);
        } catch { /* ignore */ }
      }
      const validIds = new Set<number>([parentId, ...body.children.map((c) => c.id)]);

      setState((prev) => {
        const stillValid = prev.activeSessionId != null && validIds.has(prev.activeSessionId);
        const persistedValid = persisted != null && validIds.has(persisted);
        const next = stillValid
          ? prev.activeSessionId
          : (persistedValid ? persisted : parentId);
        return {
          parent: body.parent,
          children: body.children,
          loading: false,
          activeSessionId: next,
        };
      });
    } catch (e) {
      console.error('useCompanySiblings: refresh failed:', e);
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [rootSessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setActiveSessionId = useCallback((sessionId: number | null) => {
    setState((prev) => ({ ...prev, activeSessionId: sessionId }));
    if (rootSessionId == null || typeof window === 'undefined') return;
    // The localStorage key is keyed by the ROOT session id so children
    // and parent both map back to the same persisted choice.
    try {
      const root = state.parent?.id ?? rootSessionId;
      if (sessionId == null) {
        window.localStorage.removeItem(STORAGE_KEY(root));
      } else {
        window.localStorage.setItem(STORAGE_KEY(root), String(sessionId));
      }
    } catch { /* ignore */ }
  }, [rootSessionId, state.parent]);

  const createChild = useCallback(async (name: string): Promise<CompanySession | null> => {
    if (rootSessionId == null) return null;
    const parentId = state.parent?.id ?? rootSessionId;
    try {
      const res = await fetch(`/api/company/sessions/${parentId}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        console.error(`createChild failed: ${res.status}`);
        return null;
      }
      const child = (await res.json()) as CompanySession;
      setState((prev) => ({
        ...prev,
        children: [...prev.children.filter((c) => c.id !== child.id), child]
          .sort((a, b) => a.id - b.id),
        activeSessionId: child.id,
      }));
      // Persist the new selection so a reload lands on the new tab.
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(STORAGE_KEY(parentId), String(child.id)); } catch { /* ignore */ }
      }
      return child;
    } catch (e) {
      console.error('createChild failed:', e);
      return null;
    }
  }, [rootSessionId, state.parent]);

  const renameChild = useCallback(async (childId: number, name: string): Promise<boolean> => {
    if (rootSessionId == null) return false;
    const parentId = state.parent?.id ?? rootSessionId;
    try {
      const res = await fetch(`/api/company/sessions/${parentId}/children/${childId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return false;
      const updated = (await res.json()) as CompanySession;
      setState((prev) => ({
        ...prev,
        children: prev.children.map((c) => (c.id === updated.id ? updated : c)),
      }));
      return true;
    } catch (e) {
      console.error('renameChild failed:', e);
      return false;
    }
  }, [rootSessionId, state.parent]);

  const archiveChild = useCallback(async (childId: number): Promise<boolean> => {
    if (rootSessionId == null) return false;
    const parentId = state.parent?.id ?? rootSessionId;
    try {
      const res = await fetch(`/api/company/sessions/${parentId}/children/${childId}`, {
        method: 'DELETE',
      });
      if (!res.ok) return false;
      setState((prev) => {
        const children = prev.children.filter((c) => c.id !== childId);
        const stillActive = prev.activeSessionId !== childId;
        const fallback = parentId;
        return {
          ...prev,
          children,
          activeSessionId: stillActive ? prev.activeSessionId : fallback,
        };
      });
      return true;
    } catch (e) {
      console.error('archiveChild failed:', e);
      return false;
    }
  }, [rootSessionId, state.parent]);

  return {
    ...state,
    refresh,
    setActiveSessionId,
    createChild,
    renameChild,
    archiveChild,
  };
}
