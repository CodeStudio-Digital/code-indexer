/**
 * Per-file conflict actions shared by ConflictsView (and reusable by the
 * CodeLens "mark resolved" path). Keeps the API calls + toasts in one
 * place so the view stays presentational.
 *
 * Paths here are PROJECT-relative. `resolveConflict` / `stage` take no repoPath,
 * so the backend auto-routes each path to its containing repo — a conflict
 * inside a submodule resolves against the submodule, not the opaque parent.
 * ConflictsView rebases mergeState's repoRoot-relative paths to project-relative
 * before handing them here.
 */

import { useCallback } from 'react';
import { apiCall } from '../../../../../../lib/api-client.js';
import { toast } from '../../../../../../components/ui/prompt-dialog.js';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../../../../../state/workspace.js';
import type { ConflictResolution } from '@mcp/api-bus';

export function useConflictActions(projectId: number, onMutated: () => void) {
  const { t } = useTranslation('workspace');
  const openFile = useWorkspaceStore((s) => s.openFile);
  const openMerge = useWorkspaceStore((s) => s.openMerge);

  const resolve = useCallback(
    async (path: string, resolution: ConflictResolution) => {
      try {
        await apiCall('projectGit.resolveConflict', { projectId, path, resolution });
        onMutated();
      } catch (e) {
        toast.error(t('git.conflict.resolveFailed'), {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [projectId, onMutated, t],
  );

  const acceptOurs = useCallback((path: string) => resolve(path, 'ours'), [resolve]);
  const acceptTheirs = useCallback((path: string) => resolve(path, 'theirs'), [resolve]);

  // For the hand-merge flow: after editing the file inline + saving, stage
  // it (git add) to mark the conflict resolved. Reuses the existing `stage`.
  const markResolved = useCallback(
    async (path: string) => {
      try {
        await apiCall('projectGit.stage', { projectId, paths: [path] });
        onMutated();
      } catch (e) {
        toast.error(t('git.conflict.resolveFailed'), {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [projectId, onMutated, t],
  );

  const openInEditor = useCallback(
    (path: string) => {
      openFile({ projectId, path, content: null, dirty: false, lastModified: null });
    },
    [projectId, openFile],
  );

  const openMergeTab = useCallback(
    (path: string) => {
      const name = path.split('/').pop() ?? path;
      openMerge({
        kind: 'merge',
        projectId,
        path: `merge:${path}`,
        title: t('git.conflict.mergeTabTitle', { file: name }),
        file: path,
      });
    },
    [projectId, openMerge, t],
  );

  return { acceptOurs, acceptTheirs, markResolved, openInEditor, openMergeTab };
}
