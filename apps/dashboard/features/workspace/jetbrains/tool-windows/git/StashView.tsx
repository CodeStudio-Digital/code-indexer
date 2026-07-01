/**
 * Stash view — list/save/pop/apply/drop/show entries in `git stash`.
 *
 * Mirrors `BranchesView` layout: toolbar (count + refresh + new) on top,
 * scrollable list below, row-level icon actions on hover. Operations
 * surface `GitRunResult` (not throw) so a non-zero exit (e.g. merge
 * conflict on pop) still shows the rich stderr the git CLI gives —
 * pasted into a toast so the user can act on it. The "+ Stash" button
 * opens `CreateStashDialog` (extracted to keep this file focused).
 *
 * Stash diff opens via `useWorkspaceStore.openDiff` (same path the
 * Changes tab uses) — the user sees the patch inline in the editor
 * pane to the right when the workspace is in split-Git layout.
 */

import { useCallback, useEffect, useState } from 'react';
import { Archive, Loader2, Plus, RefreshCw } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { confirm, toast } from '../../../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { CreateStashDialog } from './CreateStashDialog.js';
import { StashRow } from './StashRow.js';

interface GitStashEntry {
  index: string;
  shortSha: string;
  branch: string | null;
  message: string;
  date: string;
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface StashViewProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  /** Bubble to parent so Changes tab re-fetches status after apply/pop. */
  onMutated: () => void;
  /** A conflict is already in progress — block apply/pop. */
  opInProgress?: boolean;
}

export function StashView({ projectId, repoPath, onMutated, opInProgress }: StashViewProps) {
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const openGitStash = useWorkspaceStore((s) => s.openGitStash);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall<GitStashEntry[]>('projectGit.stashList', { projectId, repoPath });
      setStashes(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runOp = async (
    label: string,
    method: 'projectGit.stashPop' | 'projectGit.stashApply' | 'projectGit.stashDrop',
    ref: string,
    confirmDestructive = false,
  ) => {
    if (confirmDestructive) {
      const ok = await confirm({
        title: `Drop ${ref}?`,
        description: 'Stash will be permanently deleted from the repository.',
        confirmLabel: 'Drop',
        tone: 'destructive',
      });
      if (!ok) return;
    }
    setBusyRef(ref);
    try {
      const r = await apiCall<GitRunResult>(method, { projectId, repoPath, ref });
      if (r.ok) {
        toast.success(`${label} OK`, {
          description:
            r.stdout.trim().split('\n').slice(-2).join('\n') ||
            r.stderr.trim().split('\n').slice(-2).join('\n') ||
            'Done.',
        });
        // Pop/Drop remove a stash and renumber every ref above it, so any
        // open stash-preview tabs now point at the wrong (or gone) entry.
        // Close them all rather than show stale snapshots.
        if (method !== 'projectGit.stashApply') {
          const { openFiles, closeFile } = useWorkspaceStore.getState();
          for (const f of openFiles) {
            if (f.kind === 'git-stash') closeFile(f.projectId, f.path);
          }
        }
        onMutated();
        await reload();
      } else {
        toast.error(`${label} failed`, {
          description: r.stderr.trim().slice(0, 320) || r.stdout.trim().slice(0, 320),
        });
      }
    } catch (e) {
      toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyRef(null);
    }
  };

  const openDetail = (entry: GitStashEntry) => {
    openGitStash({
      kind: 'git-stash',
      projectId,
      repoPath,
      path: `gitstash:${repoPath ?? ''}:${entry.index}`,
      title: `Stash ${entry.shortSha}`,
      stashRef: entry.index,
    });
  };

  const showDiff = async (entry: GitStashEntry) => {
    try {
      const r = await apiCall<{ patch: string }>('projectGit.stashShow', {
        projectId,
        repoPath,
        ref: entry.index,
      });
      openDiff({
        kind: 'diff',
        projectId,
        path: `stash:${entry.index}`,
        title: `Stash ${entry.shortSha}: ${entry.message.slice(0, 60)}`,
        patch: r.patch,
        source: 'git-stash',
      });
    } catch (e) {
      toast.error('Show stash failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1.5 border-b flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground flex-1">
          {stashes.length === 0 && !loading
            ? 'No stashes — your working tree is clean (or unstashed).'
            : `${stashes.length} stash${stashes.length === 1 ? '' : 'es'}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void reload()}
          title="Refresh"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setCreateOpen(true)}
          title="New stash"
          disabled={opInProgress}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {error && <div className="px-2 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loading && stashes.length === 0 && (
          <div className="text-center text-[11px] text-muted-foreground p-6 flex flex-col items-center gap-2">
            <Archive className="h-5 w-5 opacity-50" />
            <p>Click + to stash your current changes.</p>
          </div>
        )}
        {stashes.map((s) => (
          <StashRow
            key={s.index}
            entry={s}
            busy={busyRef === s.index}
            opInProgress={opInProgress}
            onOpen={() => openDetail(s)}
            onPop={() => void runOp('Pop', 'projectGit.stashPop', s.index)}
            onApply={() => void runOp('Apply', 'projectGit.stashApply', s.index)}
            onDrop={() => void runOp('Drop', 'projectGit.stashDrop', s.index, true)}
            onShow={() => void showDiff(s)}
          />
        ))}
      </div>

      {createOpen && (
        <CreateStashDialog
          projectId={projectId}
          repoPath={repoPath}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            onMutated();
            void reload();
          }}
        />
      )}
    </div>
  );
}

