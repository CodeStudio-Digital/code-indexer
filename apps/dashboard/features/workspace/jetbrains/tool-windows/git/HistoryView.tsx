/**
 * History view — linear commit log for the current branch (or a
 * specific branch when the user picks one from the dropdown).
 *
 * Per-commit context menu (right-click row or icon button):
 *   - Cherry-pick onto the current branch
 *   - Revert (creates a new commit that undoes the selected one)
 *   - Reset HEAD to this commit (soft / mixed / hard sub-menu)
 *   - Copy SHA
 *
 * The list is paginated by `limit` — bump it up via the dropdown when
 * the user wants to dig deeper. We deliberately don't auto-scroll-fetch
 * (would make the right-click menu confusing as rows shift under the
 * cursor); explicit "Load more" button it is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { apiCall } from '../../../../../lib/api-client.js';
import { useGitRevision } from '../../../../../state/git-revision.js';
import { Button } from '../../../../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select.js';
import { confirm, toast } from '../../../../../components/ui/prompt-dialog.js';
import { CommitRow, type Commit } from './CommitRow.js';

interface GitRunResult {
  command: string;
  args: string[];
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface GitBranchSummary {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

interface HistoryViewProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  onMutated: () => void;
  /** A sequencer op is mid-flight — disable cherry-pick/revert/reset. */
  opInProgress?: boolean;
}

const PAGE_SIZES = [30, 60, 120, 250];

export function HistoryView({ projectId, repoPath, onMutated, opInProgress }: HistoryViewProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [branch, setBranch] = useState<string>(''); // empty = current
  const [limit, setLimit] = useState<number>(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, cs] = await Promise.all([
        apiCall<GitBranchSummary[]>('projectGit.branchesDetailed', { projectId, repoPath, includeRemote: true, rev: gitRev }),
        apiCall<Commit[]>('projectGit.log', { projectId, repoPath, limit, branch: branch || undefined }),
      ]);
      setBranches(bs);
      setCommits(cs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, repoPath, limit, branch, gitRev]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const currentBranchName = useMemo(
    () => branches.find((b) => b.isCurrent)?.name ?? null,
    [branches],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  const cherryPick = async (c: Commit) => {
    try {
      const r = await apiCall<GitRunResult>('projectGit.cherryPick', {
        projectId,
        repoPath,
        commits: [c.sha],
      });
      if (r.ok) {
        toast.success(`Cherry-picked ${c.shortSha}`);
      } else {
        toast.error('Cherry-pick had issues', {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Cherry-pick failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const revert = async (c: Commit) => {
    const ok = await confirm({
      title: `Revert ${c.shortSha}?`,
      description: `Creates a new commit that undoes the changes from "${c.subject.slice(0, 80)}". Safe — doesn't rewrite history.`,
      confirmLabel: 'Revert',
    });
    if (!ok) return;
    try {
      const r = await apiCall<GitRunResult>('projectGit.revert', { projectId, repoPath, commit: c.sha });
      if (r.ok) {
        toast.success(`Reverted ${c.shortSha}`);
      } else {
        toast.error('Revert had issues', {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Revert failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const reset = async (c: Commit, mode: 'soft' | 'mixed' | 'hard') => {
    const labelByMode = {
      soft: 'Soft (keep staged + unstaged)',
      mixed: 'Mixed (unstage but keep working tree)',
      hard: 'Hard (DISCARD all changes after this commit)',
    };
    const ok = await confirm({
      title: `Reset HEAD → ${c.shortSha}?`,
      description: `${labelByMode[mode]}. ${mode === 'hard' ? 'This DESTROYS uncommitted changes and orphans newer commits — destructive operation.' : ''}`,
      confirmLabel: `Reset --${mode}`,
      tone: mode === 'hard' ? 'destructive' : undefined,
    });
    if (!ok) return;
    try {
      const r = await apiCall<GitRunResult>('projectGit.reset', { projectId, repoPath, target: c.sha, mode });
      if (r.ok) {
        toast.success(`Reset --${mode} to ${c.shortSha}`);
      } else {
        toast.error('Reset had issues', {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Reset failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1.5 border-b flex items-center gap-1.5">
        <Select value={branch || '__current__'} onValueChange={(v) => setBranch(v === '__current__' ? '' : v)}>
          <SelectTrigger className="h-6 text-[11px] flex-1 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__current__">
              Current ({currentBranchName ?? 'HEAD'})
            </SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.name} value={b.name}>
                {b.name}
                {b.isRemote && <span className="text-muted-foreground"> (remote)</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
          <SelectTrigger className="h-6 text-[11px] w-16">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void reload()}
          title="Refresh"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {error && <div className="px-2 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {!loading && commits.length === 0 && !error && (
          <div className="text-center text-[11px] text-muted-foreground p-4">No commits.</div>
        )}
        {commits.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const c = commits[v.index];
              return (
                <div
                  key={c.sha}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  <CommitRow
                    commit={c}
                    disabled={opInProgress}
                    onCherryPick={() => void cherryPick(c)}
                    onRevert={() => void revert(c)}
                    onReset={(mode) => void reset(c, mode)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
