import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiCall = vi.hoisted(() => vi.fn());

vi.mock('../../../../../../lib/api-client.js', () => ({ apiCall }));

const { checkoutBlocker, checkoutBranch } = await import('../branch-actions.js');

describe('checkoutBranch', () => {
  beforeEach(() => {
    apiCall.mockReset();
    apiCall.mockResolvedValue({ ok: true });
  });

  it('materializes a remote ref from its exact tip as a local tracking branch', async () => {
    await expect(checkoutBranch(
      7,
      'origin/feature/nested-name',
      true,
      'packages/example',
    )).resolves.toEqual({
      name: 'feature/nested-name',
      preservedLocalChanges: false,
      restoreConflicts: false,
    });

    expect(apiCall).toHaveBeenCalledWith('projectGit.branchCheckout', {
      projectId: 7,
      repoPath: 'packages/example',
      name: 'feature/nested-name',
      create: true,
      from: 'origin/feature/nested-name',
    });
  });

  it('checks out a local branch without remote materialization options', async () => {
    await expect(checkoutBranch(7, 'feature/local', false)).resolves.toEqual({
      name: 'feature/local',
      preservedLocalChanges: false,
      restoreConflicts: false,
    });

    expect(apiCall).toHaveBeenCalledWith('projectGit.branchCheckout', {
      projectId: 7,
      repoPath: undefined,
      name: 'feature/local',
    });
  });

  it('distinguishes tracked and untracked checkout blockers', () => {
    expect(checkoutBlocker(Object.assign(new Error('blocked'), {
      code: 'git_checkout_local_changes',
    }))).toBe('tracked');
    expect(checkoutBlocker(new Error(
      'The following untracked working tree files would be overwritten by checkout:',
    ))).toBe('untracked');
    expect(checkoutBlocker(new Error('fatal: invalid reference'))).toBeNull();
  });

  it('offers Smart Checkout and restores tracked changes after switching', async () => {
    let checkoutAttempts = 0;
    let stashMarker = '';
    apiCall.mockImplementation(async (method: string, input: Record<string, unknown>) => {
      if (method === 'projectGit.branchCheckout') {
        checkoutAttempts += 1;
        if (checkoutAttempts === 1) {
          const error = new Error('Your local changes to the following files would be overwritten by checkout');
          Object.assign(error, { code: 'git_checkout_local_changes' });
          throw error;
        }
        return { ok: true };
      }
      if (method === 'projectGit.stashSave') {
        stashMarker = String(input.message);
        return { ok: true, stdout: '', stderr: '' };
      }
      if (method === 'projectGit.stashList') {
        return [{ index: 'stash@{0}', message: `On main: ${stashMarker}` }];
      }
      if (method === 'projectGit.stashPop') return { ok: true, stdout: '', stderr: '' };
      throw new Error(`Unexpected API method: ${method}`);
    });
    const confirmSmartCheckout = vi.fn().mockResolvedValue(true);

    const result = await checkoutBranch(
      7,
      'origin/feature/blocked',
      true,
      'packages/example',
      { confirmSmartCheckout },
    );

    expect(confirmSmartCheckout).toHaveBeenCalledWith('tracked', expect.any(Error));
    expect(result).toEqual({
      name: 'feature/blocked',
      preservedLocalChanges: true,
      restoreConflicts: false,
    });
    expect(apiCall).toHaveBeenCalledWith('projectGit.stashSave', expect.objectContaining({
      projectId: 7,
      repoPath: 'packages/example',
      includeUntracked: false,
      message: expect.stringContaining('CodeStudio smart checkout'),
    }));
    expect(apiCall).toHaveBeenLastCalledWith('projectGit.stashPop', {
      projectId: 7,
      repoPath: 'packages/example',
      ref: 'stash@{0}',
      restoreIndex: true,
    });
  });

  it('does not mutate the worktree when Smart Checkout is declined', async () => {
    const error = new Error('Your local changes would be overwritten by checkout');
    Object.assign(error, { code: 'git_checkout_local_changes' });
    apiCall.mockRejectedValueOnce(error);
    const confirmSmartCheckout = vi.fn().mockResolvedValue(false);

    await expect(checkoutBranch(
      7,
      'origin/feature/blocked',
      true,
      undefined,
      { confirmSmartCheckout },
    )).resolves.toBeNull();

    expect(confirmSmartCheckout).toHaveBeenCalledOnce();
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the safety stash when restoring changes produces conflicts', async () => {
    let checkoutAttempts = 0;
    let stashMarker = '';
    apiCall.mockImplementation(async (method: string, input: Record<string, unknown>) => {
      if (method === 'projectGit.branchCheckout') {
        checkoutAttempts += 1;
        if (checkoutAttempts === 1) {
          const error = new Error('Please commit your changes or stash them before you switch branches.');
          Object.assign(error, { code: 'git_checkout_local_changes' });
          throw error;
        }
        return { ok: true };
      }
      if (method === 'projectGit.stashSave') {
        stashMarker = String(input.message);
        return { ok: true, stdout: '', stderr: '' };
      }
      if (method === 'projectGit.stashList') {
        return [{ index: 'stash@{0}', message: `On main: ${stashMarker}` }];
      }
      if (method === 'projectGit.stashPop') {
        return { ok: false, stdout: '', stderr: 'CONFLICT (modify/delete)' };
      }
      throw new Error(`Unexpected API method: ${method}`);
    });

    const result = await checkoutBranch(
      7,
      'origin/feature/blocked',
      true,
      undefined,
      { confirmSmartCheckout: async () => true },
    );

    expect(result).toEqual({
      name: 'feature/blocked',
      preservedLocalChanges: true,
      restoreConflicts: true,
      restoreMessage: 'CONFLICT (modify/delete)',
      stashRef: 'stash@{0}',
    });
  });
});
