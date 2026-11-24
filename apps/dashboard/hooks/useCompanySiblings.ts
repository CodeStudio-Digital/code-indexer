/**
 * Session navigation within one company.
 *
 * Migration 067 models each entry as a full `CompanySession` with
 * `parent_session_id` pointing to the root session. This hook drives
 * the sidebar:
 *   - `parent` is the root (the "Main" session is the parent itself).
 *   - `children` are active sub-sessions ordered by creation time.
 *   - `activeSessionId` is the URL's `:frontId` segment.
 *
 * Phase 1b: selection is the URL's source of truth. `setActiveSessionId`
 * issues `navigate(...)`. A one-shot localStorage seed migrates old
 * sessions that were last opened pre-router; the entry is deleted on
 * read so the URL becomes authoritative going forward.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CompanySession } from '@mcp/company-contracts';
import { useCompanyStore, selectSiblings } from '../state/company/index.js';
import {
  buildAgentsUrl,
  parseAgentsParams,
} from '../features/agents/routing.js';
import { DEFAULT_TAB_FOR_ZONE, type Zone } from '../features/agents/zones/types.js';
import { useSurfaceVisible } from '../lib/surface-visibility.js';
import { onCompanyPanelChange } from '../lib/company-panel-changes.js';

interface SubSessionsState {
  parent: CompanySession | null;
  children: CompanySession[];
  loading: boolean;
  /** URL-derived active tab id; defaults to the parent's id (Main). */
  activeSessionId: string | null;
}

const STORAGE_KEY = (rootId: string) => `company-active-subsession:${rootId}`;

function readPersistedOnce(rootId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY(rootId));
    if (!raw) return null;
    // Drain the legacy entry — Phase 1b makes the URL authoritative; this
    // value only seeds the URL once for users mid-session.
    window.localStorage.removeItem(STORAGE_KEY(rootId));
    return raw;
  } catch {
    return null;
  }
}

export function useCompanySiblings(rootSessionId: string | null) {
  const visible = useSurfaceVisible();
  const navigate = useNavigate();
  const routeParams = useParams<{
    rootId?: string;
    frontId?: string;
    zone?: string;
    tab?: string;
  }>();
  const baseState = useCompanyStore((s) => selectSiblings(s, rootSessionId));
  const [error, setError] = useState<string | null>(null);

  const sessionEnsure = useCompanyStore((s) => s.sessionEnsure);
  const sessionLoaded = useCompanyStore((s) => s.sessionLoaded);
  const sessionSetLoading = useCompanyStore((s) => s.sessionSetLoading);
  const sessionUpsertChild = useCompanyStore((s) => s.sessionUpsertChild);
  const sessionRemoveChild = useCompanyStore((s) => s.sessionRemoveChild);

  // ─── URL-driven active session id ────────────────────────────
  const route = parseAgentsParams(routeParams, rootSessionId ?? undefined);
  const requestedSessionId = route?.frontId ?? rootSessionId;
  const activeSessionId = requestedSessionId === rootSessionId || baseState.children.some(child => child.id === requestedSessionId)
    ? requestedSessionId : rootSessionId;
  const state: SubSessionsState = { ...baseState, activeSessionId };

  // ─── Navigate helper that preserves zone+tab ────────────────
  const navigateToFront = useCallback(
    (frontId: string | 'main') => {
      if (rootSessionId == null) return;
      const zone: Zone = route?.zone ?? 'work';
      const tab = route?.tab ?? DEFAULT_TAB_FOR_ZONE[zone];
      navigate(buildAgentsUrl(rootSessionId, frontId, zone, tab));
    },
    [rootSessionId, route?.zone, route?.tab, navigate],
  );

  // One-shot localStorage migration: if the URL doesn't already pin a
  // front and the user has a legacy persisted selection, seed the URL
  // once. After this `localStorage` is no longer read.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (rootSessionId == null) return;
    if (routeParams.frontId != null) {
      seededRef.current = true;
      return;
    }
    const persisted = readPersistedOnce(rootSessionId);
    if (persisted == null) {
      seededRef.current = true;
      return;
    }
    seededRef.current = true;
    navigateToFront(persisted);
  }, [rootSessionId, routeParams.frontId, navigateToFront]);

  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    if (rootSessionId == null) return;
    const request = ++requestNumber.current;
    sessionEnsure(rootSessionId);
    sessionSetLoading(rootSessionId, true);
    try {
      const res = await fetch(`/api/company/companies/${rootSessionId}/sessions`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { parent: CompanySession; children: CompanySession[] };
      if (request !== requestNumber.current) return;
      setError(null);
      sessionLoaded(body.parent.id, body.parent, body.children);
    } catch (e) {
      if (request !== requestNumber.current) return;
      console.error('useCompanySiblings: refresh failed:', e);
      setError(e instanceof Error ? e.message : String(e));
      sessionSetLoading(rootSessionId, false);
    }
  }, [rootSessionId, sessionEnsure, sessionLoaded, sessionSetLoading]);

  useEffect(() => {
    // Coalesce mount/replacement before starting a request; a discarded
    // StrictMode mount must not publish loading/error state for its successor.
    const timer = setTimeout(() => void refresh(), 0);
    return () => { clearTimeout(timer); requestNumber.current++; };
  }, [refresh]);
  useEffect(() => onCompanyPanelChange(({ sessionId, change }) => {
    if (sessionId === rootSessionId && activeSessionId !== rootSessionId && change.kind === 'settings') void refresh();
  }), [activeSessionId, rootSessionId, refresh]);
  useEffect(() => {
    if (baseState.parent && requestedSessionId !== activeSessionId) navigateToFront('main');
  }, [baseState.parent, requestedSessionId, activeSessionId, navigateToFront]);

  // Family metadata only; no transcript scans, and no idle/background timer.
  const hasRunningSession = baseState.parent?.status === 'running'
    || baseState.children.some((child) => child.status === 'running');
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshVisible = async () => {
      if (disposed || refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try { await refresh(); } finally { refreshing = false; }
      if (!disposed && hasRunningSession) timer = setTimeout(() => void refreshVisible(), 20_000);
    };
    const onFocus = () => {
      if (timer) clearTimeout(timer);
      void refreshVisible();
    };
    if (hasRunningSession) timer = setTimeout(() => void refreshVisible(), 20_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [hasRunningSession, refresh, visible]);

  const setActiveSessionId = useCallback(
    (sessionId: string | null) => {
      if (rootSessionId == null || sessionId == null) return;
      navigateToFront(sessionId);
    },
    [rootSessionId, navigateToFront],
  );

  const createChild = useCallback(
    async (name: string): Promise<CompanySession | null> => {
      if (rootSessionId == null) return null;
      const parentId = state.parent?.id ?? rootSessionId;
      try {
        const res = await fetch(`/api/company/companies/${parentId}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          console.error(`createChild failed: ${res.status}`);
          return null;
        }
        const child = (await res.json()) as CompanySession;
        sessionUpsertChild(parentId, child);
        navigateToFront(child.id);
        return child;
      } catch (e) {
        console.error('createChild failed:', e);
        return null;
      }
    },
    [rootSessionId, state.parent, sessionUpsertChild, navigateToFront],
  );

  const renameChild = useCallback(
    async (sessionId: string, name: string): Promise<boolean> => {
      if (rootSessionId == null) return false;
      const parentId = state.parent?.id ?? rootSessionId;
      // Parent renames hit `PATCH /sessions/:id` (the session CRUD endpoint).
      // Child renames hit `PATCH /sessions/:parentId/children/:childId` so the
      // backend can enforce parent-child invariants. Same function so callers
      // (e.g. CompanySessionsSidebar) don't have to branch.
      const isParent = sessionId === parentId;
      const url = isParent
        ? `/api/company/sessions/${parentId}`
        : `/api/company/sessions/${parentId}/children/${sessionId}`;
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as CompanySession | { session: CompanySession };
        // Parent endpoint wraps in `{ session }`; child endpoint returns the row directly.
        const updated = 'session' in body ? body.session : body;
        if (isParent) {
          // Parent rename also bumps the in-store parent record so the
          // "Main" tab label refreshes without a refetch round-trip.
          sessionLoaded(parentId, updated, state.children);
        } else {
          sessionUpsertChild(parentId, updated);
        }
        return true;
      } catch (e) {
        console.error('renameChild failed:', e);
        return false;
      }
    },
    [rootSessionId, state.parent, state.children, sessionUpsertChild, sessionLoaded],
  );

  const archiveChild = useCallback(
    async (childId: string): Promise<boolean> => {
      if (rootSessionId == null) return false;
      const parentId = state.parent?.id ?? rootSessionId;
      const res = await fetch(`/api/company/sessions/${parentId}/children/${childId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        // Parse the backend's error message and surface it as an Error
        // so `FrontTabsBar.handleArchive` shows the real reason instead
        // of the generic "server rejected the request" toast.
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) detail = body.error;
        } catch {
          /* response had no JSON body */
        }
        throw new Error(detail);
      }
      sessionRemoveChild(parentId, childId);
      // Active front just disappeared — fall back to Main so the URL
      // isn't pointing at a dead child id.
      if (activeSessionId === childId) {
        navigateToFront('main');
      }
      return true;
    },
    [rootSessionId, state.parent, sessionRemoveChild, activeSessionId, navigateToFront],
  );

  return {
    parent: state.parent,
    children: state.children,
    loading: state.loading,
    error,
    activeSessionId: state.activeSessionId,
    refresh,
    setActiveSessionId,
    createChild,
    renameChild,
    archiveChild,
  };
}
