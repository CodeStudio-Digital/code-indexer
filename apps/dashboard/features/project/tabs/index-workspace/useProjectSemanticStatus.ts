import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cleanupProjectUnusedVectors,
  fetchProjectSemanticStatus,
  requestProjectSemanticReindex,
  semanticWorkIsActive,
  type ProjectSemanticStatus,
  type ProjectUnusedVectorCleanupResult,
} from './project-semantic-api.js';

interface ProjectSemanticState {
  status: ProjectSemanticStatus | null;
  loading: boolean;
  requesting: boolean;
  cleaning: boolean;
  cleanupResult: ProjectUnusedVectorCleanupResult | null;
  error: string | null;
  refresh: () => Promise<void>;
  reindex: () => Promise<void>;
  cleanupUnused: () => Promise<ProjectUnusedVectorCleanupResult>;
}

/**
 * Reads semantic state once when the project changes. Polling is armed only
 * while the server reports a targeted reindex job or a building generation;
 * mounting this hook never starts indexing.
 */
export function useProjectSemanticStatus(projectId: number): ProjectSemanticState {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [status, setStatus] = useState<ProjectSemanticStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<ProjectUnusedVectorCleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchProjectSemanticStatus(projectId);
      if (projectIdRef.current !== projectId) return;
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (projectIdRef.current !== projectId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (projectIdRef.current === projectId) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setStatus(null);
    setLoading(true);
    setRequesting(false);
    setCleaning(false);
    setCleanupResult(null);
    setError(null);
    void refresh();
  }, [projectId, refresh]);

  const active = semanticWorkIsActive(status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void refresh(), 1_000);
    return () => window.clearTimeout(timer);
  }, [active, refresh, status]);

  const reindex = useCallback(async () => {
    if (requesting || semanticWorkIsActive(status)) return;
    setRequesting(true);
    setError(null);
    try {
      const code = status?.namespaces.find((item) => item.namespace === `code:p${projectId}`);
      const action = status?.reindex_job?.status === 'paused'
        ? 'resume'
        : code?.active
          ? 'rebuild'
          : 'start';
      const job = await requestProjectSemanticReindex(projectId, action);
      if (projectIdRef.current !== projectId) return;
      setStatus((current) => current ? { ...current, reindex_job: job } : current);
      await refresh();
    } catch (cause) {
      if (projectIdRef.current !== projectId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (projectIdRef.current === projectId) setRequesting(false);
    }
  }, [projectId, refresh, requesting, status]);

  const cleanupUnused = useCallback(async () => {
    if (requesting || cleaning || semanticWorkIsActive(status)) {
      throw new Error('semantic indexing is currently active');
    }
    setCleaning(true);
    setCleanupResult(null);
    setError(null);
    try {
      const result = await cleanupProjectUnusedVectors(projectId);
      if (projectIdRef.current !== projectId) return result;
      setCleanupResult(result);
      await refresh();
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (projectIdRef.current === projectId) setError(error.message);
      throw error;
    } finally {
      if (projectIdRef.current === projectId) setCleaning(false);
    }
  }, [cleaning, projectId, refresh, requesting, status]);

  return {
    status,
    loading,
    requesting,
    cleaning,
    cleanupResult,
    error,
    refresh,
    reindex,
    cleanupUnused,
  };
}
