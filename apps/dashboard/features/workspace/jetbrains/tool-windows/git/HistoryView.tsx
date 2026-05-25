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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardCopy,
  GitCommit,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Replace,
  RotateCcw,
} from 'lucide-react';
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
import { useContextMenu, type ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';

interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

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
  onMutated: () => void;
}

const PAGE_SIZES = [30, 60, 120, 250];

export function HistoryView({ projectId, onMutated }: HistoryViewProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [branch, setBranch] = useState<string>(''); // empty = current
  const [limit, setLimit] = useState<number>(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, cs] = await Promise.all([
        apiCall<GitBranchSummary[]>('projectGit.branchesDetailed', { projectId, includeRemote: true }),
        apiCall<Commit[]>('projectGit.log', { projectId, limit, branch: branch || undefined }),
      ]);
      setBranches(bs);
      setCommits(cs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, limit, branch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const currentBranchName = useMemo(
    () => branches.find((b) => b.isCurrent)?.name ?? null,
    [branches],
  );

  const cherryPick = async (c: Commit) => {
    try {
      const r = await apiCall<GitRunResult>('projectGit.cherryPick', {
        projectId,
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
      const r = await apiCall<GitRunResult>('projectGit.revert', { projectId, commit: c.sha });
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
      const r = await apiCall<GitRunResult>('projectGit.reset', { projectId, target: c.sha, mode });
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

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loading && commits.length === 0 && !error && (
          <div className="text-center text-[11px] text-muted-foreground p-4">No commits.</div>
        )}
        {commits.map((c) => (
          <CommitRow
            key={c.sha}
            commit={c}
            onCherryPick={() => void cherryPick(c)}
            onRevert={() => void revert(c)}
            onReset={(mode) => void reset(c, mode)}
          />
        ))}
      </div>
    </div>
  );
}

function CommitRow({
  commit: c,
  onCherryPick,
  onRevert,
  onReset,
}: {
  commit: Commit;
  onCherryPick: () => void;
  onRevert: () => void;
  onReset: (mode: 'soft' | 'mixed' | 'hard') => void;
}) {
  const items: ContextMenuItem[] = [
    {
      id: 'cherry-pick',
      label: 'Cherry-pick onto current branch',
      icon: Replace,
      onSelect: onCherryPick,
    },
    {
      id: 'revert',
      label: 'Revert (new commit that undoes this)',
      icon: RotateCcw,
      onSelect: onRevert,
    },
    {
      id: 'reset-soft',
      separatorBefore: true,
      label: 'Reset HEAD → here (soft)',
      onSelect: () => onReset('soft'),
    },
    {
      id: 'reset-mixed',
      label: 'Reset HEAD → here (mixed)',
      onSelect: () => onReset('mixed'),
    },
    {
      id: 'reset-hard',
      label: 'Reset HEAD → here (hard, destructive)',
      destructive: true,
      onSelect: () => onReset('hard'),
    },
    {
      id: 'copy-sha',
      separatorBefore: true,
      label: 'Copy full SHA',
      icon: ClipboardCopy,
      onSelect: () => {
        void navigator.clipboard.writeText(c.sha).catch(() => undefined);
      },
    },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        {...triggerProps}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] hover:bg-muted/40 transition-colors',
        )}
        title={c.subject}
      >
        <GitCommit className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        <span className="font-mono text-[10px] text-muted-foreground w-14 shrink-0 truncate">
          {c.shortSha}
        </span>
        <span className="truncate flex-1">{c.subject}</span>
        <span className="text-[10px] text-muted-foreground/70 max-w-[110px] truncate shrink-0">
          {c.author}
        </span>
        <span className="text-[10px] text-muted-foreground/60 shrink-0">
          {formatDate(c.date)}
        </span>
        <button
          type="button"
          className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="More actions"
          onClick={(e) => {
            e.preventDefault();
            // Open the context menu by simulating a right-click event at
            // the button's coordinates.
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const evt = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: rect.left,
              clientY: rect.bottom,
            });
            (e.currentTarget as HTMLElement).dispatchEvent(evt);
          }}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </div>
      {Menu}
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString();
}
