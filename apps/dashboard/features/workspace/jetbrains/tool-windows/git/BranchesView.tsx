/**
 * Branches view — lists every local + remote branch with current/
 * upstream/ahead/behind info. Click a row → open its log; right-click (or
 * ⋯) → the full IntelliJ action set (checkout / new-from / merge / rebase /
 * pull / compare / rename / delete / push), built by the shared
 * `buildBranchActions` + `useBranchOps`. Toolbar: + new branch from HEAD.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GitBranch } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { useGitRevision } from '../../../../../state/git-revision.js';
import { Button } from '../../../../../components/ui/button.js';
import { Input } from '../../../../../components/ui/input.js';
import { prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { BranchRow } from './BranchRow.js';
import { useBranchOps } from './use-branch-ops.js';

type FlatRow =
  | { kind: 'header'; key: string; section: 'local' | 'remote'; title: string; open: boolean }
  | { kind: 'branch'; key: string; b: GitBranch };

interface BranchesViewProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  /** Called after every operation so the parent can refresh status etc. */
  onMutated: () => void;
  /** A sequencer op is mid-flight — disable merge/rebase/pull. */
  opInProgress?: boolean;
}

export function BranchesView({ projectId, repoPath, onMutated, opInProgress }: BranchesViewProps) {
  const { t } = useTranslation('workspace');
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openSections, setOpenSections] = useState({ local: true, remote: true });
  // Cache token: the backend memoizes branchesDetailed per (project, rev), so
  // reopening is instant until a ref actually moves (the watcher bumps gitRev).
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall<GitBranch[]>('projectGit.branchesDetailed', { projectId, repoPath, includeRemote: true, rev: gitRev });
      setBranches(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, repoPath, gitRev]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Stable getter so the shared ops hook memo doesn't churn every render.
  const branchesRef = useRef(branches);
  branchesRef.current = branches;
  const actions = useBranchOps({
    projectId,
    repoPath,
    getBranches: useCallback(() => branchesRef.current, []),
    onMutated: useCallback(async () => { await reload(); onMutated(); }, [reload, onMutated]),
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return branches.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branches, filter]);
  const local = useMemo(() => filtered.filter((b) => !b.isRemote), [filtered]);
  const remote = useMemo(() => filtered.filter((b) => b.isRemote), [filtered]);

  const createBranch = async () => {
    const name = await prompt({
      title: 'New branch',
      description: 'Branch name (created from the current HEAD; checked out immediately).',
      placeholder: 'feature/cool-thing',
    });
    if (!name?.trim()) return;
    try {
      await apiCall('projectGit.branchCreate', { projectId, repoPath, name: name.trim(), checkout: true });
      toast.success(`Created and switched to ${name.trim()}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Create failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Flatten sections + rows into one list so a repo with hundreds of remote
  // branches renders only the visible window (virtualized), not every row.
  const flat = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    if (local.length > 0) {
      rows.push({ kind: 'header', key: 'h-local', section: 'local', title: t('git.local', { count: local.length }), open: openSections.local });
      if (openSections.local) for (const b of local) rows.push({ kind: 'branch', key: `l-${b.name}`, b });
    }
    if (remote.length > 0) {
      rows.push({ kind: 'header', key: 'h-remote', section: 'remote', title: t('git.remote', { count: remote.length }), open: openSections.remote });
      if (openSections.remote) for (const b of remote) rows.push({ kind: 'branch', key: `r-${b.name}`, b });
    }
    return rows;
  }, [local, remote, openSections, t]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flat[i].kind === 'header' ? 25 : 26),
    overscan: 12,
  });

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1.5 border-b flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="h-3 w-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches…"
            className="h-6 text-[11px] pl-6"
          />
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void reload()} title="Refresh">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void createBranch()} title="New branch">
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {error && <div className="px-2 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {!loading && filtered.length === 0 && (
          <div className="text-center text-[11px] text-muted-foreground p-4">
            {filter ? `No branches match "${filter}".` : 'No branches found.'}
          </div>
        )}
        {flat.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = flat[v.index];
              const base: React.CSSProperties = { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` };
              if (row.kind === 'header') {
                return (
                  <div key={row.key} data-index={v.index} ref={virtualizer.measureElement} style={base}>
                    <button
                      type="button"
                      onClick={() => setOpenSections((s) => ({ ...s, [row.section]: !s[row.section] }))}
                      className="w-full flex items-center gap-1 px-2.5 py-1 bg-card/60 border-b text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
                    >
                      {row.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <span className="font-semibold">{row.title}</span>
                    </button>
                  </div>
                );
              }
              return (
                <div key={row.key} data-index={v.index} ref={virtualizer.measureElement} style={base}>
                  <BranchRow branch={row.b} actions={actions} opInProgress={opInProgress} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
