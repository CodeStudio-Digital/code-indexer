/**
 * Branches view — lists every local + remote branch with current/
 * upstream/ahead/behind info, plus the usual operations the user
 * expects from a JetBrains/VS Code-style git panel:
 *
 *   - click row → checkout
 *   - context icons: rename (TBD), delete, merge-into-current
 *   - toolbar: + new branch (with optional starting ref + checkout)
 *
 * Filter input on top handles the "I know it exists, just let me type"
 * case once a project grows past a screenful of branches.
 *
 * Operations are best-effort: on conflict / error we surface the
 * stderr from the git CLI in a toast so the user can act on it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  GitBranch,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { Input } from '../../../../../components/ui/input.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { cn } from '../../../../../lib/utils.js';
import { CollapsibleSection } from './CollapsibleSection.js';

interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  tipSubject: string;
}

interface GitRunResult {
  command: string;
  args: string[];
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface BranchesViewProps {
  projectId: number;
  /** Called after every operation so the parent can refresh status etc. */
  onMutated: () => void;
}

export function BranchesView({ projectId, onMutated }: BranchesViewProps) {
  const { t } = useTranslation('workspace');
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openSections, setOpenSections] = useState({ local: true, remote: true });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall<GitBranch[]>('projectGit.branchesDetailed', {
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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return branches.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branches, filter]);
  const local = useMemo(() => filtered.filter((b) => !b.isRemote), [filtered]);
  const remote = useMemo(() => filtered.filter((b) => b.isRemote), [filtered]);

  const checkout = async (b: GitBranch) => {
    if (b.isCurrent) return;
    try {
      // Remote refs need `-b <local>` to materialise a local tracking
      // branch — `git checkout origin/x` would put us on a detached HEAD.
      if (b.isRemote) {
        const local = b.name.replace(/^[^/]+\//, ''); // strip "origin/"
        await apiCall('projectGit.branchCheckout', { projectId, name: local, create: true });
      } else {
        await apiCall('projectGit.branchCheckout', { projectId, name: b.name });
      }
      toast.success(`Switched to ${b.name}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Checkout failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const createBranch = async () => {
    const name = await prompt({
      title: 'New branch',
      description: 'Branch name (created from the current HEAD; checked out immediately).',
      placeholder: 'feature/cool-thing',
    });
    if (!name?.trim()) return;
    try {
      await apiCall('projectGit.branchCreate', {
        projectId,
        name: name.trim(),
        checkout: true,
      });
      toast.success(`Created and switched to ${name.trim()}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Create failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const deleteBranch = async (b: GitBranch) => {
    if (b.isCurrent) {
      toast.error('Cannot delete the current branch', {
        description: 'Switch to a different branch first.',
      });
      return;
    }
    if (b.isRemote) {
      toast.message('Remote branches are read-only here', {
        description: 'Use `git push origin --delete <branch>` from the terminal to remove a remote branch.',
      });
      return;
    }
    const ok = await confirm({
      title: `Delete branch ${b.name}?`,
      description:
        b.ahead > 0
          ? `This branch has ${b.ahead} commit(s) NOT in any other branch — they will be lost unless force-deleted.`
          : 'The branch will be deleted from your local repo only.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      // First try a safe delete; if git refuses (unmerged work), fall
      // back to confirm + force.
      await apiCall('projectGit.branchDelete', { projectId, name: b.name });
      toast.success(`Deleted ${b.name}`);
      await reload();
      onMutated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // git emits "not fully merged" when -d refuses. Offer the force path.
      if (/not fully merged|not yet merged/i.test(msg)) {
        const force = await confirm({
          title: `Force-delete ${b.name}?`,
          description: 'Branch has unmerged commits. Force-delete loses them.',
          confirmLabel: 'Force delete',
          tone: 'destructive',
        });
        if (!force) return;
        try {
          await apiCall('projectGit.branchDelete', { projectId, name: b.name, force: true });
          toast.success(`Force-deleted ${b.name}`);
          await reload();
          onMutated();
        } catch (e2) {
          toast.error('Delete failed', {
            description: e2 instanceof Error ? e2.message : String(e2),
          });
        }
      } else {
        toast.error('Delete failed', { description: msg });
      }
    }
  };

  const mergeInto = async (b: GitBranch) => {
    const current = branches.find((x) => x.isCurrent);
    if (!current) {
      toast.error('Merge requires a current branch (detached HEAD)');
      return;
    }
    const ok = await confirm({
      title: `Merge ${b.name} into ${current.name}?`,
      description: 'Creates a merge commit if needed. Conflicts are surfaced; resolve them in the editor + finalise with a commit.',
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    try {
      const result = await apiCall<GitRunResult>('projectGit.merge', {
        projectId,
        branch: b.name,
      });
      if (result.ok) {
        toast.success(`Merged ${b.name} into ${current.name}`);
      } else {
        toast.error('Merge had issues', {
          description: result.stderr.trim().slice(0, 300) || result.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Merge failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const renderRow = (b: GitBranch) => (
    <div
      key={`${b.isRemote ? 'r' : 'l'}-${b.name}`}
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] cursor-pointer transition-colors',
        b.isCurrent ? 'bg-primary/5' : 'hover:bg-muted/40',
      )}
      onClick={() => void checkout(b)}
      title={b.isCurrent ? 'Current branch' : `Switch to ${b.name}`}
    >
      <GitBranch
        className={cn(
          'h-3 w-3 shrink-0',
          b.isCurrent ? 'text-primary' : b.isRemote ? 'text-sky-400' : 'text-muted-foreground/80',
        )}
      />
      <span
        className={cn(
          'truncate font-medium',
          b.isCurrent && 'text-foreground',
          b.isRemote && !b.isCurrent && 'text-muted-foreground',
        )}
      >
        {b.name}
      </span>
      {b.upstream && !b.isRemote && (
        <span className="text-[10px] text-muted-foreground/70 truncate">→ {b.upstream}</span>
      )}
      <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
        {b.ahead > 0 && <span className="text-emerald-400">↑{b.ahead}</span>}
        {b.behind > 0 && <span className="text-sky-400">↓{b.behind}</span>}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!b.isCurrent && !b.isRemote && (
          <button
            type="button"
            className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
            title={`Merge ${b.name} into current branch`}
            onClick={(e) => {
              e.stopPropagation();
              void mergeInto(b);
            }}
          >
            <GitMerge className="h-3 w-3" />
          </button>
        )}
        {b.isRemote && (
          <button
            type="button"
            className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Check out as local branch"
            onClick={(e) => {
              e.stopPropagation();
              void checkout(b);
            }}
          >
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
        {!b.isRemote && !b.isCurrent && (
          <button
            type="button"
            className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            title={`Delete ${b.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void deleteBranch(b);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );

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
          onClick={() => void createBranch()}
          title="New branch"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {error && <div className="px-2 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loading && filtered.length === 0 && (
          <div className="text-center text-[11px] text-muted-foreground p-4">
            {filter ? `No branches match "${filter}".` : 'No branches found.'}
          </div>
        )}
        {local.length > 0 && (
          <CollapsibleSection
            title={t('git.local', { count: local.length })}
            open={openSections.local}
            onToggle={() => setOpenSections((s) => ({ ...s, local: !s.local }))}
          >
            {local.map(renderRow)}
          </CollapsibleSection>
        )}
        {remote.length > 0 && (
          <CollapsibleSection
            title={t('git.remote', { count: remote.length })}
            open={openSections.remote}
            onToggle={() => setOpenSections((s) => ({ ...s, remote: !s.remote }))}
          >
            {remote.map(renderRow)}
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
