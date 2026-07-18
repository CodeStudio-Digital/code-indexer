export type GitPushActionRequired =
  | 'git_push_conflicts'
  | 'git_push_worktree_dirty'
  | 'git_push_update_required'
  | 'git_push_preview_stale';

export interface GitPushCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitPushRunOptions {
  kind: 'push' | 'fetch' | 'read' | 'rebase';
  env?: Record<string, string>;
}

export interface GitPushAutoUpdateOutcome<T extends GitPushCommandResult> {
  result: T;
  updatedBeforePush: boolean;
  actionRequired?: GitPushActionRequired;
  actionMessage?: string;
}

const PUSH_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

function isNonFastForwardPushRejection(result: GitPushCommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return output.includes('non-fast-forward')
    || output.includes('(fetch first)')
    || output.includes('remote contains work that you do not have locally');
}

/**
 * Retry a reviewed non-fast-forward push after one safe fetch/rebase cycle.
 * The caller owns command execution so project and workspace Git surfaces use
 * the same state machine without coupling their process adapters.
 */
export async function pushWithAutoUpdate<T extends GitPushCommandResult>(options: {
  pushArgs: string[];
  remote: string;
  branch: string;
  targetBranch: string;
  expectedHead?: string;
  pushTags?: boolean;
  allowAutoUpdate?: boolean;
  run(args: string[], options: GitPushRunOptions): Promise<T>;
}): Promise<GitPushAutoUpdateOutcome<T>> {
  const initial = await options.run(options.pushArgs, { kind: 'push', env: PUSH_ENV });
  if (
    initial.ok
    || options.allowAutoUpdate === false
    || !isNonFastForwardPushRejection(initial)
  ) {
    return { result: initial, updatedBeforePush: false };
  }

  const needsAction = (
    result: T,
    actionRequired: GitPushActionRequired,
    actionMessage: string,
    updatedBeforePush = false,
  ): GitPushAutoUpdateOutcome<T> => ({
    result,
    updatedBeforePush,
    actionRequired,
    actionMessage,
  });

  const remoteRef = `refs/remotes/${options.remote}/${options.targetBranch}`;
  const fetch = await options.run(
    ['fetch', '--no-tags', options.remote, `+refs/heads/${options.targetBranch}:${remoteRef}`],
    { kind: 'fetch', env: PUSH_ENV },
  );
  if (!fetch.ok) {
    return needsAction(
      fetch,
      'git_push_update_required',
      'The remote branch advanced, but it could not be fetched automatically. Update the branch before pushing.',
    );
  }

  const [actualHead, currentBranch, trackedChanges] = await Promise.all([
    options.run(['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`], { kind: 'read' }),
    options.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { kind: 'read' }),
    options.run(['status', '--porcelain', '--untracked-files=no'], { kind: 'read' }),
  ]);
  if (
    !actualHead.ok
    || (options.expectedHead && actualHead.stdout.trim() !== options.expectedHead)
    || !currentBranch.ok
    || currentBranch.stdout.trim() !== options.branch
  ) {
    return needsAction(
      initial,
      'git_push_preview_stale',
      'The branch changed after this push preview was opened. Review it again before pushing.',
    );
  }
  if (!trackedChanges.ok || trackedChanges.stdout.trim()) {
    return needsAction(
      initial,
      'git_push_worktree_dirty',
      'The remote branch advanced, but the working tree has uncommitted changes. Commit or stash them before updating and pushing.',
    );
  }
  if (options.pushTags) {
    return needsAction(
      initial,
      'git_push_update_required',
      'The remote branch advanced while tags were selected. Update the branch and review the tag targets before pushing.',
    );
  }

  const remoteAlreadyContained = await options.run(
    ['merge-base', '--is-ancestor', remoteRef, `refs/heads/${options.branch}`],
    { kind: 'read' },
  );
  if (remoteAlreadyContained.code !== 0 && remoteAlreadyContained.code !== 1) {
    return needsAction(
      initial,
      'git_push_update_required',
      'The remote branch advanced, but Git could not compare the local and remote histories. Update the branch before pushing.',
    );
  }

  if (remoteAlreadyContained.code === 1) {
    const rebase = await options.run(
      ['-c', 'rebase.autoStash=false', 'rebase', remoteRef],
      {
        kind: 'rebase',
        env: { ...PUSH_ENV, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
      },
    );
    if (!rebase.ok) {
      const conflicts = await options.run(
        ['diff', '--name-only', '--diff-filter=U'],
        { kind: 'read' },
      );
      const hasConflicts = conflicts.ok && conflicts.stdout.trim().length > 0;
      return needsAction(
        rebase,
        hasConflicts ? 'git_push_conflicts' : 'git_push_update_required',
        hasConflicts
          ? 'The remote branch advanced and the automatic rebase found conflicts. Resolve them before pushing.'
          : 'The remote branch advanced, but it could not be rebased automatically. Update the branch before pushing.',
      );
    }
  }

  const retry = await options.run(options.pushArgs, { kind: 'push', env: PUSH_ENV });
  if (!retry.ok) {
    return needsAction(
      retry,
      'git_push_update_required',
      'The branch was updated, but the push still could not be completed. Review the remote state before retrying.',
      true,
    );
  }
  return { result: retry, updatedBeforePush: true };
}
