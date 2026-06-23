/**
 * Shared branch operations used by both the Branches tab (context menu)
 * and the Git Log surface (the "Switch to …" button). Keeping the
 * remote-tracking nuance in one place avoids the detached-HEAD footgun
 * being re-derived per call site.
 */

import { apiCall } from '../../../../../lib/api-client.js';

/**
 * Check out `branch`. Remote refs (`origin/x`) can't be checked out
 * directly — that lands on a detached HEAD — so we materialise a local
 * tracking branch with `-b <local>` instead. Returns the local branch
 * name we ended up on (for the success toast). Throws the git stderr on
 * failure so the caller can surface it.
 */
export async function checkoutBranch(
  projectId: number,
  branch: string,
  isRemote: boolean,
): Promise<string> {
  if (isRemote) {
    const local = branch.replace(/^[^/]+\//, ''); // strip "origin/"
    await apiCall('projectGit.branchCheckout', { projectId, name: local, create: true });
    return local;
  }
  await apiCall('projectGit.branchCheckout', { projectId, name: branch });
  return branch;
}
