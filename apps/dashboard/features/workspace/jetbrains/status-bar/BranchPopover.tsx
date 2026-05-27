/**
 * JetBrains-style branch popover anchored to the status-bar git chip.
 *
 *   Layout (top → bottom):
 *     - search box (filters branches AND quick-action rows by label),
 *     - quick actions: Update Project · Commit · Push · New Branch ·
 *       Checkout Tag/Revision,
 *     - current branch (read-only marker w/ ahead/behind),
 *     - Local Branches (filtered),
 *     - Remote Branches (collapsed by default).
 *
 * Mutating handlers live in `useBranchActions`. Row primitives live in
 * `branch-popover-rows`. This file owns layout + data fetching only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Input } from '../../../../components/ui/input.js';
import {
  ActionRow,
  BranchRow,
  SectionHeader,
  type BranchRowData,
} from './branch-popover-rows.js';
import { useBranchActions } from './use-branch-actions.js';

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
  const [showRemote, setShowRemote] = useState(false);

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
      });
      setBranches(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { current, locals, remotes } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (b: BranchRowData) => !q || b.name.toLowerCase().includes(q);
    const cur = branches.find((b) => b.isCurrent) ?? null;
    const locals = branches.filter((b) => !b.isRemote && !b.isCurrent && matches(b));
    const remotes = branches.filter((b) => b.isRemote && matches(b));
    return { current: cur, locals, remotes };
  }, [branches, filter]);

  const remoteAvailable = current?.upstream || branches.some((b) => b.isRemote);

  return (
    <div className="w-[340px] max-h-[520px] flex flex-col text-[11.5px]">
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
          onClick={() => {
            onRequestCommit();
            onClose();
          }}
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

      {current && (
        <div className="shrink-0 px-2.5 py-1.5 border-b bg-primary/5">
          <div className="text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground mb-0.5">
            Current Branch
          </div>
          <div className="flex items-center gap-1.5">
            <GitBranchIcon className="h-3 w-3 text-primary shrink-0" />
            <span className="truncate font-medium">{current.name}</span>
            {current.upstream && (
              <span className="text-[10px] text-muted-foreground/70 truncate">
                → {current.upstream}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5 text-[10px]">
              {current.ahead > 0 && <span className="text-emerald-400">↑{current.ahead}</span>}
              {current.behind > 0 && <span className="text-sky-400">↓{current.behind}</span>}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="grid place-items-center py-6 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
          </div>
        )}
        {error && <div className="px-3 py-2 text-destructive">{error}</div>}

        {!loading && locals.length > 0 && (
          <SectionHeader>Local Branches{filter ? ` · ${locals.length}` : ''}</SectionHeader>
        )}
        {locals.map((b) => (
          <BranchRow
            key={`l-${b.name}`}
            branch={b}
            busy={actions.busyAction === `Switch ${b.name}`}
            onClick={() => void actions.checkout(b)}
          />
        ))}

        {remotes.length > 0 && (
          <button
            type="button"
            onClick={() => setShowRemote((v) => !v)}
            className="w-full px-2.5 py-1 flex items-center gap-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground border-t mt-0.5"
          >
            {showRemote ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="font-semibold">Remote Branches · {remotes.length}</span>
          </button>
        )}
        {showRemote &&
          remotes.map((b) => (
            <BranchRow
              key={`r-${b.name}`}
              branch={b}
              busy={actions.busyAction === `Switch ${b.name}`}
              onClick={() => void actions.checkout(b)}
            />
          ))}

        {!loading && locals.length === 0 && remotes.length === 0 && filter && (
          <div className="text-center py-4 text-muted-foreground">
            No branches match “{filter}”.
          </div>
        )}
      </div>
    </div>
  );
}
