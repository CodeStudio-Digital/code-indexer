import type { GitRunResult } from '@mcp/api-bus';
import type { TFunction } from 'i18next';
import { toast } from '../../../../../components/ui/prompt-dialog.js';
import { useGitActiveRepo } from '../../../../../state/git-active-repo.js';
import { useWorkspaceLayout } from '../../../../../state/workspace-layout.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';

/** Shared by Update Project and the branch menu, including autostash conflicts. */
export function showGitUpdateResult(
  result: GitRunResult,
  { projectId, repoPath, successTitle, t }: {
    projectId: number;
    repoPath?: string;
    successTitle: string;
    t: TFunction<'workspace'>;
  },
): void {
  if (result.updateActionRequired === 'conflicts') {
    toast.warning(t('git.branch.updateConflicts'), {
      description: t('git.branch.updateConflictsDescription'), duration: 10_000,
    });
    // A slow update must not navigate away from a different project opened meanwhile.
    if (useWorkspaceStore.getState().activeProjectId === projectId) {
      useGitActiveRepo.getState().setRepo(projectId, repoPath);
      useWorkspaceLayout.getState().setPrimarySurface('editor');
      useWorkspaceLayout.getState().setActiveLeft('git');
    }
  } else if (result.ok) {
    toast.success(successTitle);
  } else {
    toast.error(t('git.branch.updateIssues'), {
      description: result.stderr.trim().slice(0, 320) || result.stdout.trim().slice(0, 320),
    });
  }
}
