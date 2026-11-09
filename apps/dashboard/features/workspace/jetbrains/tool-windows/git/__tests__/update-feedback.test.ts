import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRunResult } from '@mcp/api-bus';
import type { TFunction } from 'i18next';

const state = vi.hoisted(() => ({
  activeProjectId: 1,
  setRepo: vi.fn(), setPrimarySurface: vi.fn(), setActiveLeft: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../../../../../components/ui/prompt-dialog.js', () => ({ toast: state.toast }));
vi.mock('../../../../../../state/git-active-repo.js', () => ({ useGitActiveRepo: { getState: () => state } }));
vi.mock('../../../../../../state/workspace-layout.js', () => ({ useWorkspaceLayout: { getState: () => state } }));
vi.mock('../../../../../../state/workspace.js', () => ({ useWorkspaceStore: { getState: () => state } }));
import { showGitUpdateResult } from '../update-feedback.js';

const result: GitRunResult = { command: 'git', args: ['pull'], ok: false, code: 1, stdout: '', stderr: '' };
const options = { projectId: 1, repoPath: 'C:/fixture/nested', successTitle: 'updated', t: ((key: string) => key) as TFunction<'workspace'> };
beforeEach(() => { vi.clearAllMocks(); state.activeProjectId = 1; });

describe('Git update feedback', () => {
  it('opens the affected repository for conflict resolution instead of announcing success', () => {
    showGitUpdateResult({ ...result, updateActionRequired: 'conflicts', conflictedFiles: ['shared.txt'] }, options);
    expect(state.toast.warning).toHaveBeenCalledOnce();
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.setRepo).toHaveBeenCalledWith(1, 'C:/fixture/nested');
    expect(state.setPrimarySurface).toHaveBeenCalledWith('editor');
    expect(state.setActiveLeft).toHaveBeenCalledWith('git');
  });

  it('does not navigate away from a project opened while the update was running', () => {
    state.activeProjectId = 2;
    showGitUpdateResult({ ...result, updateActionRequired: 'conflicts' }, options);
    expect(state.toast.warning).toHaveBeenCalledOnce();
    expect(state.setRepo).not.toHaveBeenCalled();
    expect(state.setPrimarySurface).not.toHaveBeenCalled();
    expect(state.setActiveLeft).not.toHaveBeenCalled();
  });

  it('keeps an ordinary remote failure visible without opening conflict resolution', () => {
    showGitUpdateResult({ ...result, stderr: 'remote unavailable' }, options);
    expect(state.toast.error).toHaveBeenCalledWith('git.branch.updateIssues', { description: 'remote unavailable' });
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.setActiveLeft).not.toHaveBeenCalled();
  });

  it('announces a completed update without changing the active surface', () => {
    showGitUpdateResult({ ...result, ok: true, code: 0 }, options);
    expect(state.toast.success).toHaveBeenCalledWith('updated');
    expect(state.toast.warning).not.toHaveBeenCalled();
    expect(state.setActiveLeft).not.toHaveBeenCalled();
  });
});
