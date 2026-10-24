/**
 * Shared branch operations used by both the Branches tab (context menu)
 * and the Git Log surface (the "Switch to …" button). Keeping the
 * remote-tracking nuance in one place avoids the detached-HEAD footgun
 * being re-derived per call site.
 */

import type { GitRunResult, GitStashEntry } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';

type CheckoutBlocker = 'tracked' | 'untracked';

interface CheckoutBranchResult {
  name: string;
  preservedLocalChanges: boolean;
  restoreConflicts: boolean;
  restoreMessage?: string;
  stashRef?: string;
}

interface CheckoutBranchOptions {
  confirmSmartCheckout?: (
    blocker: CheckoutBlocker,
    error: Error,
  ) => boolean | Promise<boolean>;
}

let smartCheckoutSequence = 0;

function checkoutInput(
  projectId: number,
  branch: string,
  isRemote: boolean,
  repoPath?: string,
): {
  input: Record<string, unknown>;
  localName: string;
} {
  if (isRemote) {
    const localName = branch.replace(/^[^/]+\//, '');
    return {
      localName,
      input: {
        projectId,
        repoPath,
        name: localName,
        create: true,
        from: branch,
      },
    };
  }
  return {
    localName: branch,
    input: { projectId, repoPath, name: branch },
  };
}

export function checkoutBlocker(error: unknown): CheckoutBlocker | null {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === 'git_checkout_untracked_files') return 'untracked';
  if (value?.code === 'git_checkout_local_changes') return 'tracked';

  const message = value?.message ?? String(error);
  if (/untracked working tree files would be overwritten by checkout/i.test(message)) return 'untracked';
  if (
    /local changes to the following files would be overwritten by checkout/i.test(message)
    || /commit your changes or stash them before you switch branches/i.test(message)
  ) return 'tracked';
  return null;
}

function resultMessage(result: GitRunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

async function findTemporaryStash(
  input: Record<string, unknown>,
  marker: string,
): Promise<GitStashEntry | undefined> {
  const stashes = await apiCall<GitStashEntry[]>('projectGit.stashList', {
    projectId: input.projectId,
    repoPath: input.repoPath,
  });
  return stashes.find((stash) => stash.message.includes(marker));
}

async function performCheckout(
  input: Record<string, unknown>,
): Promise<void> {
  await apiCall('projectGit.branchCheckout', input);
}

async function smartCheckout(
  input: Record<string, unknown>,
  localName: string,
  blocker: CheckoutBlocker,
): Promise<CheckoutBranchResult> {
  const marker = `CodeStudio smart checkout ${Date.now()}-${++smartCheckoutSequence}: ${localName}`;
  const save = await apiCall<GitRunResult>('projectGit.stashSave', {
    projectId: input.projectId,
    repoPath: input.repoPath,
    message: marker,
    includeUntracked: blocker === 'untracked',
  });
  if (!save.ok) {
    throw new Error(resultMessage(save) || 'Could not preserve local changes before checkout.');
  }

  const temporaryStash = await findTemporaryStash(input, marker);
  if (!temporaryStash) {
    throw new Error('Local changes were preserved, but the temporary stash could not be identified. Checkout was not attempted.');
  }

  try {
    await performCheckout(input);
  } catch (checkoutError) {
    const currentStash = await findTemporaryStash(input, marker);
    if (!currentStash) {
      throw new Error(
        `${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}\n`
        + 'The temporary safety stash could not be found, so it was not restored automatically.',
      );
    }
    const restore = await apiCall<GitRunResult>('projectGit.stashPop', {
      projectId: input.projectId,
      repoPath: input.repoPath,
      ref: currentStash.index,
      restoreIndex: true,
    });
    if (!restore.ok) {
      throw new Error(
        `${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}\n`
        + `Local changes remain safe in ${currentStash.index}; restoring them also needs attention: `
        + (resultMessage(restore) || 'git stash pop failed'),
      );
    }
    throw checkoutError;
  }

  const currentStash = await findTemporaryStash(input, marker);
  if (!currentStash) {
    return {
      name: localName,
      preservedLocalChanges: true,
      restoreConflicts: true,
      restoreMessage: 'The temporary safety stash could not be found after checkout.',
    };
  }
  const restore = await apiCall<GitRunResult>('projectGit.stashPop', {
    projectId: input.projectId,
    repoPath: input.repoPath,
    ref: currentStash.index,
    restoreIndex: true,
  });
  return {
    name: localName,
    preservedLocalChanges: true,
    restoreConflicts: !restore.ok,
    ...(restore.ok ? {} : {
      restoreMessage: resultMessage(restore),
      stashRef: currentStash.index,
    }),
  };
}

/**
 * Check out `branch`. Remote refs (`origin/x`) can't be checked out
 * directly — that lands on a detached HEAD — so we materialise a local
 * tracking branch from the selected remote ref instead. Returns the local branch
 * branch. When local changes block the operation, the caller can authorize a
 * Smart Checkout that stashes, switches, and restores without discarding work.
 */
export async function checkoutBranch(
  projectId: number,
  branch: string,
  isRemote: boolean,
  repoPath?: string,
  options: CheckoutBranchOptions = {},
): Promise<CheckoutBranchResult | null> {
  const { input, localName } = checkoutInput(projectId, branch, isRemote, repoPath);
  try {
    await performCheckout(input);
    return {
      name: localName,
      preservedLocalChanges: false,
      restoreConflicts: false,
    };
  } catch (error) {
    const blocker = checkoutBlocker(error);
    if (!blocker || !options.confirmSmartCheckout) throw error;
    const proceed = await options.confirmSmartCheckout(
      blocker,
      error instanceof Error ? error : new Error(String(error)),
    );
    if (!proceed) return null;
    return smartCheckout(input, localName, blocker);
  }
}
