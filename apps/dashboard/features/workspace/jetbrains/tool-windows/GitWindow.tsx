/**
 * Git tool window — local working-tree status for the project's
 * `root_path`. Replaces the Day-6 placeholder.
 *
 * UI:
 *   - Header: current branch · ahead/behind · refresh + commit buttons
 *   - Staged section (collapsible)  — toggle stage with the icon button
 *   - Unstaged section (collapsible) — stage / discard per file
 *   - Untracked section (collapsible) — stage adds them, discard deletes
 *   - Empty state when the working tree is clean
 *   - Friendly notice when root_path isn't a git repo
 *
 * Diffs aren't rendered inline yet — click a file to copy its unified
 * diff to the clipboard. Side-by-side diff in the editor pane lands in
 * a follow-up commit once a tab-style "diff: src/foo.ts" surface exists.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit as GitCommitIcon,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { Button } from '../../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { cn } from '../../../../lib/utils.js';

interface GitStatusFile {
  path: string;
  state: string;
  staged: boolean;
}

interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  repoRoot: string | null;
  notARepo: boolean;
}

interface GitWindowProps {
  projectId: number;
  onClose?: () => void;
}

function fileKind(state: string): { letter: string; color: string } {
  switch (state) {
    case 'modified': return { letter: 'M', color: 'text-amber-500' };
    case 'added':    return { letter: 'A', color: 'text-emerald-500' };
    case 'deleted':  return { letter: 'D', color: 'text-destructive' };
    case 'renamed':  return { letter: 'R', color: 'text-cyan-400' };
    case 'copied':   return { letter: 'C', color: 'text-cyan-400' };
    case 'untracked':return { letter: '?', color: 'text-muted-foreground' };
    case 'unmerged': return { letter: '!', color: 'text-destructive' };
    default:         return { letter: '·', color: 'text-muted-foreground' };
  }
}

export function GitWindow({ projectId, onClose }: GitWindowProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [openSections, setOpenSections] = useState({ staged: true, unstaged: true, untracked: false });
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  const showDiff = useCallback(
    async (file: GitStatusFile) => {
      try {
        const r = await apiCall<{ patch: string }>('projectGit.diff', {
          projectId,
          path: file.path,
          staged: file.staged,
        });
        openDiff({
          kind: 'diff',
          projectId,
          path: `diff:${file.staged ? 'staged' : 'unstaged'}:${file.path}`,
          title: `${file.staged ? 'Staged' : 'Diff'}: ${file.path.split('/').pop() ?? file.path}`,
          patch: r.patch,
          source: file.staged ? 'git-staged' : 'git-unstaged',
        });
      } catch (err) {
        window.alert(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, openDiff],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const s = await apiCall<GitStatus>('projectGit.status', { projectId });
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => {
    const staged: GitStatusFile[] = [];
    const unstaged: GitStatusFile[] = [];
    const untracked: GitStatusFile[] = [];
    for (const f of status?.files ?? []) {
      if (f.staged) staged.push(f);
      else if (f.state === 'untracked') untracked.push(f);
      else unstaged.push(f);
    }
    return { staged, unstaged, untracked };
  }, [status]);

  const onStage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.stage', { projectId, paths });
      await reload();
    } catch (err) {
      window.alert(`Stage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const onUnstage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.unstage', { projectId, paths });
      await reload();
    } catch (err) {
      window.alert(`Unstage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const onDiscard = async (paths: string[]) => {
    if (!window.confirm(`Discard local changes to ${paths.length} file(s)?`)) return;
    try {
      await apiCall('projectGit.discard', { projectId, paths });
      await reload();
    } catch (err) {
      window.alert(`Discard failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (status?.notARepo) {
    return (
      <ToolWindowFrame title="Git" onClose={onClose}>
        <div className="h-full grid place-items-center px-6 text-center text-muted-foreground gap-2">
          <GitBranch className="h-5 w-5 opacity-50" />
          <p className="text-[11.5px]">
            This project's root isn't a git repository yet.
            <br />
            Run <code className="font-mono text-foreground/80">git init</code> in the terminal to start.
          </p>
        </div>
      </ToolWindowFrame>
    );
  }

  return (
    <>
      <ToolWindowFrame
        title="Git"
        onClose={onClose}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => void reload()}
              aria-label="Refresh"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => setCommitOpen(true)}
              disabled={groups.staged.length === 0}
              aria-label="Commit"
              title="Commit staged changes"
            >
              <GitCommitIcon className="h-3 w-3" />
            </Button>
          </>
        }
      >
        <div className="h-full flex flex-col min-h-0">
          {status && (
            <div className="shrink-0 px-2.5 py-1.5 border-b text-[11px] flex items-center gap-2">
              <GitBranch className="h-3 w-3 text-primary" />
              <span className="font-medium truncate">{status.branch ?? '(detached HEAD)'}</span>
              {status.upstream && (
                <span className="text-muted-foreground/70 truncate">→ {status.upstream}</span>
              )}
              <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                {status.ahead > 0 && <span>↑ {status.ahead}</span>}
                {status.behind > 0 && <span>↓ {status.behind}</span>}
              </span>
            </div>
          )}
          {error && <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>}
          {status && !error && status.files.length === 0 && (
            <div className="flex-1 grid place-items-center text-center text-muted-foreground gap-2 px-4">
              <Check className="h-5 w-5 text-emerald-500 opacity-70" />
              <p className="text-[11.5px]">Working tree clean — nothing to commit.</p>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {groups.staged.length > 0 && (
              <Section
                title={`Staged (${groups.staged.length})`}
                open={openSections.staged}
                onToggle={() => setOpenSections((s) => ({ ...s, staged: !s.staged }))}
                bulkAction={
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => void onUnstage(groups.staged.map((f) => f.path))}
                  >
                    Unstage all
                  </button>
                }
              >
                {groups.staged.map((f) => (
                  <FileRow
                    key={`s-${f.path}`}
                    file={f}
                    onClick={() => void showDiff(f)}
                    actions={
                      <RowButton
                        icon={Minus}
                        title="Unstage"
                        onClick={() => void onUnstage([f.path])}
                      />
                    }
                  />
                ))}
              </Section>
            )}
            {groups.unstaged.length > 0 && (
              <Section
                title={`Changes (${groups.unstaged.length})`}
                open={openSections.unstaged}
                onToggle={() => setOpenSections((s) => ({ ...s, unstaged: !s.unstaged }))}
                bulkAction={
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => void onStage(groups.unstaged.map((f) => f.path))}
                  >
                    Stage all
                  </button>
                }
              >
                {groups.unstaged.map((f) => (
                  <FileRow
                    key={`u-${f.path}`}
                    file={f}
                    onClick={() => void showDiff(f)}
                    actions={
                      <>
                        <RowButton
                          icon={Plus}
                          title="Stage"
                          onClick={() => void onStage([f.path])}
                        />
                        <RowButton
                          icon={Undo2}
                          title="Discard"
                          destructive
                          onClick={() => void onDiscard([f.path])}
                        />
                      </>
                    }
                  />
                ))}
              </Section>
            )}
            {groups.untracked.length > 0 && (
              <Section
                title={`Untracked (${groups.untracked.length})`}
                open={openSections.untracked}
                onToggle={() => setOpenSections((s) => ({ ...s, untracked: !s.untracked }))}
                bulkAction={
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => void onStage(groups.untracked.map((f) => f.path))}
                  >
                    Stage all
                  </button>
                }
              >
                {groups.untracked.map((f) => (
                  <FileRow
                    key={`x-${f.path}`}
                    file={f}
                    actions={
                      <>
                        <RowButton
                          icon={Plus}
                          title="Stage"
                          onClick={() => void onStage([f.path])}
                        />
                        <RowButton
                          icon={Trash2}
                          title="Delete (untracked only)"
                          destructive
                          onClick={() => void onDiscard([f.path])}
                        />
                      </>
                    }
                  />
                ))}
              </Section>
            )}
          </div>
        </div>
      </ToolWindowFrame>
      {commitOpen && (
        <CommitDialog
          projectId={projectId}
          stagedCount={groups.staged.length}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => {
            setCommitOpen(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  bulkAction?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, open, onToggle, bulkAction, children }: SectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 px-2.5 py-1 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border-b">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-semibold">{title}</span>
        </button>
        {bulkAction && <div className="ml-auto">{bulkAction}</div>}
      </div>
      {open && children}
    </div>
  );
}

function FileRow({
  file,
  actions,
  onClick,
}: {
  file: GitStatusFile;
  actions: React.ReactNode;
  onClick?: () => void;
}) {
  const k = fileKind(file.state);
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-2.5 py-1 transition-colors border-b last:border-b-0 text-[11.5px]',
        onClick ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/40',
      )}
      onClick={onClick}
      title={onClick ? `Open diff for ${file.path}` : file.path}
    >
      <span className={cn('font-mono text-[10px] w-3 shrink-0 text-center', k.color)}>
        {k.letter}
      </span>
      <span className="truncate flex-1">{file.path}</span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {actions}
      </div>
    </div>
  );
}

function RowButton({
  icon: Icon,
  title,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'h-5 w-5 grid place-items-center rounded-sm transition-colors',
        destructive
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

interface CommitDialogProps {
  projectId: number;
  stagedCount: number;
  onClose: () => void;
  onCommitted: () => void;
}

function CommitDialog({ projectId, stagedCount, onClose, onCommitted }: CommitDialogProps) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiCall<{ sha: string }>('projectGit.commit', { projectId, message });
      onCommitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-2">
            <GitCommitIcon className="h-4 w-4 text-primary" />
            Commit {stagedCount} file{stagedCount === 1 ? '' : 's'}
          </DialogTitle>
        </DialogHeader>
        <textarea
          autoFocus
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          className="w-full min-h-[140px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        {err && <div className="text-[11px] text-destructive">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void commit()} disabled={busy || !message.trim()}>
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
