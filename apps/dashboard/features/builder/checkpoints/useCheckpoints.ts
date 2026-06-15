/**
 * Data layer of the checkpoint timeline: list (with a slow poll so new
 * run-end checkpoints appear without manual refresh), forward-only
 * restore, and "view diff" — which opens the unified patch as a
 * workspace diff tab (Monaco DiffEditor) instead of a bespoke viewer.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiPost } from '../../../hooks/useApi.js';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';

export interface BuilderCheckpoint {
  id: number;
  project_id: number;
  session_id: number | null;
  commit_sha: string;
  label: string;
  kind: 'auto' | 'visual' | 'restore' | 'manual';
  screenshot_path: string | null;
  created_at: string;
}

const POLL_MS = 15_000;

export function useCheckpoints(projectId: number) {
  const [checkpoints, setCheckpoints] = useState<BuilderCheckpoint[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl()}/api/projects/${projectId}/checkpoints`);
      if (!res.ok) return; // non-builder projects 400 — timeline simply stays empty
      const body = (await res.json()) as { checkpoints?: BuilderCheckpoint[] };
      setCheckpoints(body.checkpoints ?? []);
    } catch {
      /* transient — next poll retries */
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const restore = useCallback(
    async (checkpointId: number) => {
      setBusyId(checkpointId);
      setError(null);
      try {
        await apiPost(`/projects/${projectId}/checkpoints/${checkpointId}/restore`, {});
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'restore failed');
      } finally {
        setBusyId(null);
      }
    },
    [projectId, refresh],
  );

  /** Open the checkpoint's patch as a workspace diff tab (vs parent or vs `fromId`). */
  const viewDiff = useCallback(
    async (checkpoint: BuilderCheckpoint, fromId?: number) => {
      setError(null);
      try {
        const qs = fromId != null ? `?from=${fromId}` : '';
        const res = await fetch(
          `${apiBaseUrl()}/api/projects/${projectId}/checkpoints/${checkpoint.id}/diff${qs}`,
        );
        if (!res.ok) throw new Error(`diff failed (HTTP ${res.status})`);
        const body = (await res.json()) as { patch: string; truncated: boolean };
        const title = `Checkpoint: ${checkpoint.label || checkpoint.commit_sha.slice(0, 7)}`;
        useWorkspaceStore.getState().openDiff({
          kind: 'diff',
          projectId,
          path: `diff:checkpoint-${checkpoint.id}${fromId != null ? `-from-${fromId}` : ''}`,
          title,
          patch: body.truncated ? `${body.patch}\n\n[diff truncated]` : body.patch,
          source: 'other',
        });
        window.dispatchEvent(new CustomEvent('mcp:open-files-tab', { detail: { projectId } }));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'diff failed');
      }
    },
    [projectId],
  );

  return { checkpoints, refresh, restore, viewDiff, busyId, error };
}

export function thumbnailUrl(projectId: number, checkpoint: BuilderCheckpoint): string | null {
  if (!checkpoint.screenshot_path) return null;
  return `${apiBaseUrl()}/api/projects/${projectId}/checkpoints/${checkpoint.id}/thumbnail`;
}
