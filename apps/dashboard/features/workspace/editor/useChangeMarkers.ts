/**
 * React glue that lights up IntelliJ-style git change markers in MonacoMount.
 * Fetches the file's HEAD content (the baseline) once per file, re-fetches when
 * the project's git revision bumps (commit / checkout / reset), and attaches a
 * live tracker that diffs the baseline against the buffer, paints the gutter,
 * and serves the click toolbar (rollback / copy / navigate / stage / commit).
 *
 * Detaches when the project isn't a repo, while content is loading, or on a
 * model swap. Mirrors `useConflictMarkers`'s shape.
 */

import { useEffect, useMemo, useState } from 'react';
import type * as MonacoNs from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { OpenFile } from '../../../state/workspace.js';
import { useGitRevision } from '../../../state/git-revision.js';
import { apiCall } from '../../../lib/api-client.js';
import { saveFile } from './save.js';
import {
  attachChangeTracker,
  type ChangeTrackerDeps,
  type StageRange,
} from './change-markers/attach-change-tracker.js';

interface BaselineResult {
  content: string | null;
  isRepo: boolean;
}

export function useChangeMarkers(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const { t } = useTranslation('workspace');
  const gitRev = useGitRevision((s) => s.revByProject[file.projectId] ?? 0);
  const hasContent = file.content !== null;
  // Tagged with the path it was fetched for, so a file switch detaches until
  // the new baseline lands (no diffing the new buffer against the old HEAD).
  const [base, setBase] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    if (!hasContent) return;
    let alive = true;
    // Re-fetch on every (path, gitRev) change — deliberately NOT cached across
    // remounts: a baseline cache would freeze transient `git show` failures and
    // go stale after a same-branch commit in a linked worktree (gitRev doesn't
    // bump for those), showing a committed file as still-modified.
    apiCall<BaselineResult>('projectGit.baseline', { projectId: file.projectId, path: file.path })
      .then((r) => {
        if (!alive) return;
        // Not a repo → no markers. New/untracked file → '' (whole file added).
        setBase(r.isRepo ? { path: file.path, content: r.content ?? '' } : null);
      })
      .catch(() => {
        if (alive) setBase(null);
      });
    return () => {
      alive = false;
    };
  }, [file.projectId, file.path, hasContent, gitRev]);

  const baseline = base && base.path === file.path ? base.content : null;

  // Stage / commit a single block: flush the buffer to disk (so the staging
  // diff's new side matches the editor), stage just that hunk, then optionally
  // commit. Keyed on the stable (projectId, path) — NOT the `file` object,
  // whose identity changes every keystroke — so the tracker doesn't re-attach
  // on every edit.
  const { projectId, path } = file;
  const deps = useMemo<ChangeTrackerDeps>(() => {
    const stage = async (range: StageRange, message?: string): Promise<void> => {
      try {
        await saveFile(projectId, path);
        await apiCall('projectGit.stageHunk', { projectId, path, ...range });
        if (message) {
          await apiCall('projectGit.commit', { projectId, message });
          toast.success(t('git.changeMarker.committed'));
        } else {
          toast.success(t('git.changeMarker.staged'));
        }
      } catch (err) {
        toast.error(t('git.changeMarker.stageFailed'), {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };
    return {
      labels: {
        prev: t('git.changeMarker.prev'),
        next: t('git.changeMarker.next'),
        rollback: t('git.changeMarker.rollback'),
        copy: t('git.changeMarker.copy'),
        showOriginal: t('git.changeMarker.showOriginal'),
        stage: t('git.changeMarker.stage'),
        commit: t('git.changeMarker.commit'),
        commitPlaceholder: t('git.changeMarker.commitPlaceholder'),
        close: t('git.changeMarker.close'),
      },
      onStage: (range) => void stage(range),
      onCommit: (range, message) => void stage(range, message),
    };
  }, [projectId, path, t]);

  useEffect(() => {
    if (!editor || !monaco || baseline === null || !hasContent) return;
    const tracker = attachChangeTracker(editor, monaco, baseline, deps);
    return () => tracker.dispose();
  }, [editor, monaco, baseline, hasContent, deps]);
}
