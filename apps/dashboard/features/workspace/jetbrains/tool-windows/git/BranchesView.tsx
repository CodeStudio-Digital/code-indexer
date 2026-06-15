/**
 * Branches view — lists every local + remote branch with current/
 * upstream/ahead/behind info, plus the usual operations the user
 * expects from a JetBrains/VS Code-style git panel:
 *
 *   - click row → open the branch log in the content area
 *   - right-click (or ⋯) → full menu: switch, new-from, rename, merge,
 *     push, delete, copy name
 *   - toolbar: + new branch (from current HEAD, checked out immediately)
 *
 * Filter input on top handles the "I know it exists, just let me type"
 * case once a project grows past a screenful of branches.
 *
 * Operations are best-effort: on conflict / error we surface the
 * stderr from the git CLI in a toast so the user can act on it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { Button } from '../../../../../components/ui/button.js';
import { Input } from '../../../../../components/ui/input.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { CollapsibleSection } from './CollapsibleSection.js';
import { BranchRow, type GitBranch } from './BranchRow.js';
import { checkoutBranch } from './branch-actions.js';

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
  const openGitLog = useWorkspaceStore((s) => s.openGitLog);

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

  const openLog = (b: GitBranch) => {
    openGitLog({
      kind: 'git-log',
      projectId,
      path: `gitlog:${b.name}`,
      title: `Log: ${b.name}`,
      branch: b.name,
      isRemote: b.isRemote,
    });
  };

  const switchTo = async (b: GitBranch) => {
    if (b.isCurrent) return;
    try {
      const name = await checkoutBranch(projectId, b.name, b.isRemote);
      toast.success(`Switched to ${name}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Checkout failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const newBranchFrom = async (b: GitBranch) => {
    const name = await prompt({
      title: `New branch from ${b.name}`,
      description: 'Created from the selected branch and checked out immediately.',
      placeholder: 'feature/cool-thing',
    });
    if (!name?.trim()) return;
    try {
      await apiCall('projectGit.branchCreate', {
        projectId,
        name: name.trim(),
        from: b.name,
        checkout: true,
      });
      toast.success(`Created and switched to ${name.trim()}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Create failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const renameBranch = async (b: GitBranch) => {
    const newName = await prompt({
      title: `Rename ${b.name}`,
      description: 'New branch name.',
      placeholder: b.name,
      defaultValue: b.name,
    });
    if (!newName?.trim() || newName.trim() === b.name) return;
    try {
      await apiCall('projectGit.branchRename', { projectId, oldName: b.name, newName: newName.trim() });
      toast.success(`Renamed to ${newName.trim()}`);
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Rename failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const pushBranch = async (b: GitBranch) => {
    try {
      // `git push` needs an explicit remote when a refspec is given —
      // otherwise the lone positional (`b.name`) is read as the REMOTE
      // name (`git push -u main` → "main is not a repository"). Derive it
      // from the upstream (`origin/main` → `origin`); default to origin
      // for a branch that doesn't track one yet.
      const remote = b.upstream ? b.upstream.split('/')[0] : 'origin';
      const r = await apiCall<GitRunResult>('projectGit.push', {
        projectId,
        remote,
        branch: b.name,
        setUpstream: !b.upstream,
      });
      if (r.ok) {
        toast.success(`Pushed ${b.name}`);
      } else {
        toast.error('Push had issues', {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error('Push failed', { description: e instanceof Error ? e.message : String(e) });
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

  const actions = {
    onOpenLog: openLog,
    onSwitch: (b: GitBranch) => void switchTo(b),
    onNewBranchFrom: (b: GitBranch) => void newBranchFrom(b),
    onRename: (b: GitBranch) => void renameBranch(b),
    onMerge: (b: GitBranch) => void mergeInto(b),
    onPush: (b: GitBranch) => void pushBranch(b),
    onDelete: (b: GitBranch) => void deleteBranch(b),
  };
  const renderRow = (b: GitBranch) => (
    <BranchRow key={`${b.isRemote ? 'r' : 'l'}-${b.name}`} branch={b} actions={actions} />
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
