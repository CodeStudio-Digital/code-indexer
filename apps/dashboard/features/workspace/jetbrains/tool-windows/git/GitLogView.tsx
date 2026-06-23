/**
 * Git Log surface — opened in the editor content area when the user
 * clicks a branch in the Branches tab. Lists every commit on that
 * branch (left) with a live commit preview (right), JetBrains-style.
 *
 * Distinct from the History sub-tab (which lives in the narrow Git tool
 * window): this is the roomy, dedicated surface where selecting a commit
 * shows its files + message and clicking a file opens its diff.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowRightLeft, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select.js';
import { confirm, toast } from '../../../../../components/ui/prompt-dialog.js';
import type { OpenGitLog } from '../../../../../state/workspace.js';
import { requestGitReload, onGitReloadRequest } from '../../../editor/conflict-registry.js';
import { CommitRow, type Commit } from './CommitRow.js';
import { CommitDetailPanel } from './CommitDetailPanel.js';
import { checkoutBranch } from './branch-actions.js';

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const PAGE_SIZES = [60, 120, 250, 500];

export function GitLogView({ tab }: { tab: OpenGitLog }) {
  const { projectId, branch, isRemote } = tab;
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(120);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [opInProgress, setOpInProgress] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, status, ms] = await Promise.all([
        apiCall<Commit[]>('projectGit.log', { projectId, limit, branch }),
        apiCall<{ branch: string | null }>('projectGit.status', { projectId, includeFiles: false }),
        apiCall<{ kind: string | null }>('projectGit.mergeState', { projectId }),
      ]);
      setCommits(cs);
      setCurrentBranch(status.branch);
      setOpInProgress(ms.kind !== null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, branch, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the commit-action gating fresh when a conflict is started/resolved
  // from another surface (the 3-pane merge editor, the Git window banner).
  useEffect(() => onGitReloadRequest(() => void reload()), [reload]);

  const isCurrent = !isRemote && currentBranch === branch;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  const switchTo = async () => {
    try {
      const name = await checkoutBranch(projectId, branch, isRemote);
      toast.success(`Switched to ${name}`);
      await reload();
    } catch (e) {
      toast.error('Checkout failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Commit ops mirror the History tab — they always act on the *current*
  // branch (cherry-pick/revert/reset don't checkout first), so we refresh
  // afterwards to reflect the new HEAD.
  const runOp = async (
    label: string,
    path: 'projectGit.cherryPick' | 'projectGit.revert' | 'projectGit.reset',
    body: object,
  ) => {
    try {
      const r = await apiCall<GitRunResult>(path, { projectId, ...body });
      if (r.ok) toast.success(`${label} ok`);
      else
        toast.error(`${label} had issues`, {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      await reload();
      // A conflict here must light up the Git tool window's banner/Conflicts tab.
      requestGitReload();
    } catch (e) {
      toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const revert = async (c: Commit) => {
    const ok = await confirm({
      title: `Revert ${c.shortSha}?`,
      description: `Creates a new commit that undoes "${c.subject.slice(0, 80)}". Safe — doesn't rewrite history.`,
      confirmLabel: 'Revert',
    });
    if (ok) await runOp('Revert', 'projectGit.revert', { commit: c.sha });
  };

  const reset = async (c: Commit, mode: 'soft' | 'mixed' | 'hard') => {
    const ok = await confirm({
      title: `Reset HEAD → ${c.shortSha}?`,
      description:
        mode === 'hard'
          ? 'Hard reset DESTROYS uncommitted changes and orphans newer commits — destructive.'
          : `Reset --${mode}. Moves the current branch tip to this commit.`,
      confirmLabel: `Reset --${mode}`,
      tone: mode === 'hard' ? 'destructive' : undefined,
    });
    if (ok) await runOp('Reset', 'projectGit.reset', { target: c.sha, mode });
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-[12px] font-medium truncate">{branch}</span>
        {isCurrent ? (
          <span className="text-[10px] text-emerald-400 shrink-0">current</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => void switchTo()}
            title={isRemote ? `Check out ${branch} as a local branch` : `Switch to ${branch}`}
          >
            <ArrowRightLeft className="h-3 w-3" />
            {isRemote ? 'Checkout' : 'Switch'}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
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
      </div>

      {error && <div className="px-3 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <PanelGroup direction="horizontal" autoSaveId="mcp-git-log-split" className="flex-1 min-h-0">
        <Panel defaultSize={56} minSize={30}>
          <div ref={scrollRef} className="h-full overflow-y-auto">
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
                        selected={selected === c.sha}
                        disabled={opInProgress}
                        onSelect={() => setSelected(c.sha)}
                        onCherryPick={() => void runOp('Cherry-pick', 'projectGit.cherryPick', { commits: [c.sha] })}
                        onRevert={() => void revert(c)}
                        onReset={(mode) => void reset(c, mode)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
        <Panel defaultSize={44} minSize={25}>
          <CommitDetailPanel projectId={projectId} sha={selected} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
