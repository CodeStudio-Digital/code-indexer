/**
 * Git tool window — shell. Estado/lógica vivem em `git/use-git-window.ts`; a barra de
 * sub-abas em `git/GitTabNav.tsx`. Este arquivo só compõe o frame + o branch header +
 * o banner de merge + a sub-view ativa.
 *
 *   - Changes  → working-tree status (stage / unstage / commit / discard)
 *   - Branches → list locals + remotes, checkout, create, delete, merge
 *   - History  → linear commit log per branch
 *   - Stash    → stash list / apply / pop / drop
 *   - Conflicts→ só durante uma op de sequencer (merge/cherry-pick/revert/rebase)
 *   - AI       → natural-language → plan of git commands → confirm → execute
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/ui/popover.js';
import { BranchPopover } from '../status-bar/BranchPopover.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { BranchesView } from './git/BranchesView.js';
import { HistoryView } from './git/HistoryView.js';
import { GitPromptView } from './git/GitPromptView.js';
import { StashView } from './git/StashView.js';
import { ChangesPane } from './git/ChangesPane.js';
import { GitPerfPanel } from './git/GitPerfPanel.js';
import { MergeBanner } from './git/merge/MergeBanner.js';
import { ConflictsView } from './git/merge/ConflictsView.js';
import { requestGitReload } from '../../editor/conflict-registry.js';
import { GitTabNav } from './git/GitTabNav.js';
import { useGitWindow } from './git/use-git-window.js';
import { RepoSelector } from './git/RepoSelector.js';
import { useProjectRepos } from './git/use-project-repos.js';
import { useActiveRepoPath } from '../../../../state/git-active-repo.js';

interface GitWindowProps {
  projectId: number;
  active?: boolean;
  onClose?: () => void;
}

export function GitWindow({ projectId, active = true, onClose }: GitWindowProps) {
  const { t } = useTranslation('workspace');
  // Multi-repo: the selected git root (submodule / nested repo) the window acts
  // on. Fall back to the MAIN repo's explicit absPath when nothing is selected or
  // the stored selection is stale — the window ALWAYS sends an explicit repoPath
  // so its (single-repo) status never collides with the explorer's project-wide
  // aggregate (which is the no-repoPath call). Undefined only until repos load.
  const { repos, loading: reposLoading } = useProjectRepos(projectId);
  const storedRepo = useActiveRepoPath(projectId);
  const repoPath =
    storedRepo && repos.some((r) => r.absPath === storedRepo)
      ? storedRepo
      : repos.find((r) => r.kind === 'main')?.absPath;
  // The active repo's project-relative prefix ('' = main) — lets useGitWindow
  // rebase repoRoot-relative conflict paths to project-relative for the editor.
  // A '..'-based prefix means the project sits BELOW this repo's root (a project
  // nested under a bigger repo); there's no clean project-relative rebase, so
  // fall back to '' (the pre-existing project-IS-repo-root behavior).
  const rawPrefix = repos.find((r) => r.absPath === repoPath)?.projectRelPrefix ?? '';
  const repoPrefix = rawPrefix.startsWith('..') ? '' : rawPrefix;
  const {
    status, loading, error, openSections, setOpenSections, tab, setTab, mergeState,
    groups, reload, showDiff, onStage, onUnstage, onDiscard,
  } = useGitWindow(projectId, active, repoPath, repoPrefix, !reposLoading);
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);

  if (status?.notARepo) {
    return (
      <ToolWindowFrame title="Git" onClose={onClose}>
        <div className="h-full grid place-items-center px-6 text-center text-muted-foreground gap-2">
          <GitBranch className="h-5 w-5 opacity-50" />
          <p className="text-[11.5px]">
            {t('git.notRepo')}
            <br />
            {t('git.initHint')}
          </p>
        </div>
      </ToolWindowFrame>
    );
  }

  return (
    <ToolWindowFrame
      title="Git"
      onClose={onClose}
      actions={
        <>
          <GitPerfPanel projectId={projectId} repoPath={repoPath} />
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={() => void reload()}
            aria-label={t('git.refresh')}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </>
      }
    >
      <div className="h-full flex flex-col min-h-0">
        {/* Repo selector — only when the project actually has >1 git root. */}
        {repos.length > 1 && <RepoSelector projectId={projectId} repos={repos} selected={repoPath} />}
        {/* Branch header — clickable branch switcher (search + switch + actions),
            JetBrains-style; reuses the status-bar branch popover. */}
        {status && (
          <div className="shrink-0 px-2.5 py-1.5 border-b text-[11px] flex items-center gap-2">
            <Popover open={branchSwitcherOpen} onOpenChange={setBranchSwitcherOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 min-w-0 flex-1 rounded px-1 -mx-1 hover:bg-muted/40 transition-colors"
                  title={t('git.switchBranch')}
                >
                  <GitBranch className="h-3 w-3 text-primary shrink-0" />
                  <span className="font-medium truncate">{status.branch ?? t('git.detachedHead')}</span>
                  {status.upstream && (
                    <span className="text-muted-foreground/70 truncate">→ {status.upstream}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="start" className="p-0 overflow-hidden">
                <BranchPopover
                  projectId={projectId}
                  repoPath={repoPath}
                  onMutated={() => void reload()}
                  onClose={() => setBranchSwitcherOpen(false)}
                  onRequestCommit={() => { setTab('changes'); setBranchSwitcherOpen(false); }}
                />
              </PopoverContent>
            </Popover>
            <span className="ml-auto flex items-center gap-2 text-muted-foreground shrink-0">
              {status.ahead > 0 && <span>↑ {status.ahead}</span>}
              {status.behind > 0 && <span>↓ {status.behind}</span>}
            </span>
          </div>
        )}

        {/* Merge/cherry-pick/revert em progresso → banner com Resolve + Abort. */}
        {mergeState?.kind && (
          <MergeBanner projectId={projectId} repoPath={repoPath} state={mergeState} onMutated={requestGitReload} />
        )}

        <GitTabNav
          active={tab}
          onChange={setTab}
          conflictCount={mergeState?.kind ? mergeState.conflictedFiles.length : null}
        />

        {error && tab === 'changes' && (
          <div className="px-3 py-2 text-[11px] text-destructive shrink-0">{error}</div>
        )}

        {active && tab === 'changes' && (
          <ChangesPane
            projectId={projectId}
            repoPath={repoPath}
            status={status}
            error={error}
            groups={groups}
            openSections={openSections}
            setOpenSections={setOpenSections}
            showDiff={showDiff}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            onCommitted={() => void reload()}
          />
        )}
        {active && tab === 'branches' && (
          <BranchesView projectId={projectId} repoPath={repoPath} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {active && tab === 'history' && (
          <HistoryView projectId={projectId} repoPath={repoPath} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {active && tab === 'stash' && (
          <StashView projectId={projectId} repoPath={repoPath} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {active && tab === 'conflicts' && mergeState && (
          <ConflictsView projectId={projectId} repoPrefix={repoPrefix} state={mergeState} onMutated={requestGitReload} />
        )}
        {active && tab === 'ai' && <GitPromptView projectId={projectId} repoPath={repoPath} onMutated={() => void reload()} />}
      </div>
    </ToolWindowFrame>
  );
}
