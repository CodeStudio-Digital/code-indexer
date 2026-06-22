/**
 * JetBrains-style branch popover (status-bar chip + Git tool-window header):
 * search + quick actions + a collapsible current/Local/Remote branch list.
 * Clicking a branch opens its action set in a panel BESIDE the list (an
 * IntelliJ flyout, not a drill-in that hides the list). Quick-action handlers
 * live in `useBranchActions`; per-branch ops in `useBranchOps`; row primitives
 * in `branch-popover-rows`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  GitBranch as GitBranchIcon,
  GitCommit as GitCommitIcon,
  Loader2,
  Plus,
  Search,
  Tag,
  Upload,
} from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { useGitRevision } from '../../../../state/git-revision.js';
import { cn } from '../../../../lib/utils.js';
import { Input } from '../../../../components/ui/input.js';
import {
  ActionRow,
  type BranchRowData,
} from './branch-popover-rows.js';
import { useBranchActions } from './use-branch-actions.js';
import { useBranchOps } from '../tool-windows/git/use-branch-ops.js';
import { BranchActionPanel, BranchListRow, RemoteBranchList } from './branch-action-menu.js';

interface BranchPopoverProps {
  projectId: number;
  /** Refresh chips/data when an operation succeeds. */
  onMutated: () => void;
  /** Open the commit modal owned by the workspace (we don't redo the UI). */
  onRequestCommit: () => void;
  /** Close the popover (passed to row clicks so checkout dismisses it). */
  onClose: () => void;
}

export function BranchPopover({
  projectId,
  onMutated,
  onRequestCommit,
  onClose,
}: BranchPopoverProps) {
  const [branches, setBranches] = useState<BranchRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showLocal, setShowLocal] = useState(true);
  const [showRemote, setShowRemote] = useState(false);
  // When set, that branch's actions open in a panel BESIDE the list (the list
  // stays visible — IntelliJ-style flyout, not a full-screen drill-in).
  const [menuBranch, setMenuBranch] = useState<BranchRowData | null>(null);
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);

  const actions = useBranchActions({
    projectId,
    onMutated: () => {
      // Refresh both the parent chips AND our local branches list so the
      // popover reflects post-op state (e.g. new upstream after push).
      onMutated();
      void reload();
    },
    onClose,
  });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall<BranchRowData[]>('projectGit.branchesDetailed', {
        projectId,
        includeRemote: true,
        rev: gitRev, // backend caches per (project, rev) → instant reopen
      });
      setBranches(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, gitRev]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Per-branch IntelliJ action set (checkout / merge / rebase / pull / compare
  // / rename / delete / push), shared with the Git tool window's Branches tab.
  // A stable getter via a ref keeps the ops object from churning every render.
  const branchesRef = useRef<BranchRowData[]>([]);
  branchesRef.current = branches;
  const branchOps = useBranchOps({
    projectId,
    getBranches: useCallback(() => branchesRef.current, []),
    onMutated: useCallback(async () => { onMutated(); await reload(); }, [onMutated, reload]),
    onClose,
  });

  const { current, locals, remotes } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (b: BranchRowData) => !q || b.name.toLowerCase().includes(q);
    const cur = branches.find((b) => b.isCurrent) ?? null;
    const locals = branches.filter((b) => !b.isRemote && !b.isCurrent && matches(b));
    const remotes = branches.filter((b) => b.isRemote && matches(b));
    return { current: cur, locals, remotes };
  }, [branches, filter]);

  const remoteAvailable = current?.upstream || branches.some((b) => b.isRemote);
  const sectionToggle = 'w-full px-2.5 py-1 flex items-center gap-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground';

  return (
    <div className="flex text-[11.5px]">
      {/* LIST column */}
      <div className="w-[320px] max-h-[520px] flex flex-col">
        <div className="shrink-0 px-2 pt-2 pb-1.5 border-b">
          <div className="relative">
            <Search className="h-3 w-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search branches / actions…"
              autoFocus
              className="h-7 text-[11.5px] pl-7"
            />
          </div>
        </div>

        <div className="shrink-0 py-1 border-b">
          {remoteAvailable && (
            <ActionRow
              icon={ArrowDownToLine}
              label="Update Project"
              hint="Ctrl+T"
              busy={actions.busyAction === 'Update Project' || actions.busyAction === 'Pull (rebase)'}
              onClick={() => void actions.onUpdateProject()}
              filter={filter}
            />
          )}
          <ActionRow
            icon={GitCommitIcon}
            label="Commit…"
            hint="Ctrl+K"
            onClick={() => { onRequestCommit(); onClose(); }}
            filter={filter}
          />
          {remoteAvailable && (
            <ActionRow
              icon={Upload}
              label="Push"
              hint="Ctrl+Shift+K"
              busy={actions.busyAction === 'Push'}
              onClick={() => current && void actions.onPush(!!current.upstream)}
              filter={filter}
            />
          )}
          <ActionRow
            icon={Plus}
            label="New Branch…"
            hint="Ctrl+Alt+N"
            busy={actions.busyAction === 'New Branch'}
            onClick={() => void actions.onNewBranch()}
            filter={filter}
          />
          <ActionRow
            icon={Tag}
            label="Checkout Tag or Revision…"
            busy={actions.busyAction === 'Checkout'}
            onClick={() => void actions.onCheckoutRevision()}
            filter={filter}
          />
        </div>

        {/* Current branch — clickable into its actions (Update/pull, push, …). */}
        {current && (
          <button
            type="button"
            onClick={() => setMenuBranch(current)}
            className={cn(
              'shrink-0 w-full text-left px-2.5 py-1.5 border-b transition-colors',
              menuBranch?.name === current.name ? 'bg-muted' : 'bg-primary/5 hover:bg-primary/10',
            )}
          >
            <div className="text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground mb-0.5">Current Branch</div>
            <div className="flex items-center gap-1.5">
              <GitBranchIcon className="h-3 w-3 text-primary shrink-0" />
              <span className="truncate font-medium">{current.name}</span>
              {current.upstream && (
                <span className="text-[10px] text-muted-foreground/70 truncate">→ {current.upstream}</span>
              )}
              <span className="ml-auto flex items-center gap-1.5 text-[10px]">
                {current.ahead > 0 && <span className="text-emerald-400">↑{current.ahead}</span>}
                {current.behind > 0 && <span className="text-sky-400">↓{current.behind}</span>}
                <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              </span>
            </div>
          </button>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="grid place-items-center py-6 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
            </div>
          )}
          {error && <div className="px-3 py-2 text-destructive">{error}</div>}

          {!loading && locals.length > 0 && (
            <button type="button" onClick={() => setShowLocal((v) => !v)} className={sectionToggle}>
              {showLocal ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span className="font-semibold">Local Branches · {locals.length}</span>
            </button>
          )}
          {showLocal &&
            locals.map((b) => (
              <BranchListRow key={`l-${b.name}`} branch={b} onPick={setMenuBranch} selected={menuBranch?.name === b.name} />
            ))}

          {remotes.length > 0 && (
            <button type="button" onClick={() => setShowRemote((v) => !v)} className={cn(sectionToggle, 'border-t mt-0.5')}>
              {showRemote ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span className="font-semibold">Remote Branches · {remotes.length}</span>
            </button>
          )}
          {showRemote && <RemoteBranchList remotes={remotes} onPick={setMenuBranch} selectedName={menuBranch?.name} />}

          {!loading && locals.length === 0 && remotes.length === 0 && filter && (
            <div className="text-center py-4 text-muted-foreground">No branches match “{filter}”.</div>
          )}
        </div>
      </div>

      {/* ACTIONS column — opens BESIDE the list (the famous IntelliJ flyout). */}
      {menuBranch && (
        <div className="w-[210px] max-h-[520px] border-l bg-popover">
          <BranchActionPanel branch={menuBranch} ops={branchOps} onBack={() => setMenuBranch(null)} />
        </div>
      )}
    </div>
  );
}
