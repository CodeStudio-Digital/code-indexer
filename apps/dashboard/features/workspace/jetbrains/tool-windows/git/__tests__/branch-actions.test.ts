import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiCall = vi.hoisted(() => vi.fn());

vi.mock('../../../../../../lib/api-client.js', () => ({ apiCall }));

const { checkoutBranch } = await import('../branch-actions.js');

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
    )).resolves.toBe('feature/nested-name');

    expect(apiCall).toHaveBeenCalledWith('projectGit.branchCheckout', {
      projectId: 7,
      repoPath: 'packages/example',
      name: 'feature/nested-name',
      create: true,
      from: 'origin/feature/nested-name',
    });
  });

  it('checks out a local branch without remote materialization options', async () => {
    await expect(checkoutBranch(7, 'feature/local', false)).resolves.toBe('feature/local');

    expect(apiCall).toHaveBeenCalledWith('projectGit.branchCheckout', {
      projectId: 7,
      repoPath: undefined,
      name: 'feature/local',
    });
  });
});
