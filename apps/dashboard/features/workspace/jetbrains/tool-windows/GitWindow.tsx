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
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { BranchesView } from './git/BranchesView.js';
import { HistoryView } from './git/HistoryView.js';
import { GitPromptView } from './git/GitPromptView.js';
import { StashView } from './git/StashView.js';
import { ChangesPane } from './git/ChangesPane.js';
import { MergeBanner } from './git/merge/MergeBanner.js';
import { ConflictsView } from './git/merge/ConflictsView.js';
import { requestGitReload } from '../../editor/conflict-registry.js';
import { GitTabNav } from './git/GitTabNav.js';
import { useGitWindow } from './git/use-git-window.js';

interface GitWindowProps {
  projectId: number;
  onClose?: () => void;
}

export function GitWindow({ projectId, onClose }: GitWindowProps) {
  const { t } = useTranslation('workspace');
  const {
    status, loading, error, openSections, setOpenSections, tab, setTab, mergeState,
    groups, reload, showDiff, onStage, onUnstage, onDiscard,
  } = useGitWindow(projectId);

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
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={() => void reload()}
          aria-label={t('git.refresh')}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      }
    >
      <div className="h-full flex flex-col min-h-0">
        {/* Branch header — sempre visível; ancora o painel ao estado do repo. */}
        {status && (
          <div className="shrink-0 px-2.5 py-1.5 border-b text-[11px] flex items-center gap-2">
            <GitBranch className="h-3 w-3 text-primary" />
            <span className="font-medium truncate">{status.branch ?? t('git.detachedHead')}</span>
            {status.upstream && (
              <span className="text-muted-foreground/70 truncate">→ {status.upstream}</span>
            )}
            <span className="ml-auto flex items-center gap-2 text-muted-foreground">
              {status.ahead > 0 && <span>↑ {status.ahead}</span>}
              {status.behind > 0 && <span>↓ {status.behind}</span>}
            </span>
          </div>
        )}

        {/* Merge/cherry-pick/revert em progresso → banner com Resolve + Abort. */}
        {mergeState?.kind && (
          <MergeBanner projectId={projectId} state={mergeState} onMutated={requestGitReload} />
        )}

        <GitTabNav
          active={tab}
          onChange={setTab}
          conflictCount={mergeState?.kind ? mergeState.conflictedFiles.length : null}
        />

        {error && tab === 'changes' && (
          <div className="px-3 py-2 text-[11px] text-destructive shrink-0">{error}</div>
        )}

        {tab === 'changes' && (
          <ChangesPane
            projectId={projectId}
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
        {tab === 'branches' && (
          <BranchesView projectId={projectId} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {tab === 'history' && (
          <HistoryView projectId={projectId} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {tab === 'stash' && (
          <StashView projectId={projectId} onMutated={() => void reload()} opInProgress={!!mergeState?.kind} />
        )}
        {tab === 'conflicts' && mergeState && (
          <ConflictsView projectId={projectId} state={mergeState} onMutated={requestGitReload} />
        )}
        {tab === 'ai' && <GitPromptView projectId={projectId} onMutated={() => void reload()} />}
      </div>
    </ToolWindowFrame>
  );
}
