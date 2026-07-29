/**
 * Hook that owns the side-effecting handlers for the BranchPopover:
 * remote-sync (update / push), branch creation, ad-hoc checkout, and
 * single-branch switch. Returns a tagged `busyAction` so the parent can
 * disable matching rows + show a spinner.
 *
 * Why a hook instead of plain functions: each handler needs to set
 * `busy`/`error`, call `onMutated`/`onClose`, and surface toasts —
 * threading those through ~6 prop drills was uglier than a 1-import
 * `useBranchActions(...)` call.
 */

import { useState } from 'react';
import { apiCall } from '../../../../lib/api-client.js';
import { prompt, toast } from '../../../../components/ui/prompt-dialog.js';
import type { BranchRowData } from './branch-popover-rows.js';
import { openProjectPushDialog } from '../../../git-push/push-dialog-store.js';

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface UseBranchActions {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  onMutated: () => void;
  onClose: () => void;
}

export function useBranchActions({ projectId, repoPath, onMutated, onClose }: UseBranchActions) {
  // `busyAction` doubles as "currently running" indicator and matches
  // against either an action label ("Update Project") or a per-branch
  // key ("Switch feature/foo") so the corresponding row can spin.
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const runRemoteOp = async (
    label: string,
    method: 'projectGit.fetch' | 'projectGit.pull',
    payload: object,
  ): Promise<boolean> => {
    setBusyAction(label);
    try {
      const r = await apiCall<GitRunResult>(method, { projectId, repoPath, ...payload });
      if (r.ok) {
        toast.success(`${label} OK`, {
          description:
            r.stdout.trim().split('\n').slice(-3).join('\n') ||
            r.stderr.trim().split('\n').slice(-3).join('\n') ||
            'No output.',
        });
        onMutated();
        return true;
      }
      toast.error(`${label} failed`, {
        description: r.stderr.trim().slice(0, 320) || r.stdout.trim().slice(0, 320),
      });
      return false;
    } catch (e) {
      toast.error(`${label} failed`, {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  // IntelliJ's "Update Project" = fetch then pull --rebase. We chain
  // them so the user gets one click → both succeed / fail with their
  // own toasts. If fetch fails, we still attempt pull (it often
  // succeeds via cached refs).
  const onUpdateProject = async () => {
    await runRemoteOp('Update Project', 'projectGit.fetch', { prune: true });
    await runRemoteOp('Pull (rebase)', 'projectGit.pull', { rebase: true });
  };

  const onPush = (currentHasUpstream: boolean) => {
    openProjectPushDialog({
      projectId,
      repoPath,
      setUpstream: !currentHasUpstream,
      onPushed: onMutated,
    });
    onClose();
  };

  const onNewBranch = async () => {
    const name = await prompt({
      title: 'New branch',
      description: 'Created from current HEAD; checked out immediately.',
      placeholder: 'feature/cool-thing',
    });
    if (!name?.trim()) return;
    setBusyAction('New Branch');
    try {
      await apiCall('projectGit.branchCreate', {
        projectId,
        repoPath,
        name: name.trim(),
        checkout: true,
      });
      toast.success(`Switched to ${name.trim()}`);
      onMutated();
      onClose();
    } catch (e) {
      toast.error('Create failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyAction(null);
    }
  };

  const onCheckoutRevision = async () => {
    const ref = await prompt({
      title: 'Checkout Tag or Revision',
      description: 'Enter a branch name, tag, or commit SHA.',
      placeholder: 'v1.2.0  ·  4a3f2b1  ·  release/2025-Q4',
    });
    if (!ref?.trim()) return;
    setBusyAction('Checkout');
    try {
      await apiCall('projectGit.branchCheckout', { projectId, repoPath, name: ref.trim() });
      toast.success(`Checked out ${ref.trim()}`);
      onMutated();
      onClose();
    } catch (e) {
      toast.error('Checkout failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const checkout = async (b: BranchRowData) => {
    if (b.isCurrent) return;
    setBusyAction(`Switch ${b.name}`);
    try {
      if (b.isRemote) {
        // Materialise a local tracking branch when picking a remote ref
        // — bare `git checkout origin/foo` would land on detached HEAD.
        const local = b.name.replace(/^[^/]+\//, '');
        await apiCall('projectGit.branchCheckout', {
          projectId,
          repoPath,
          name: local,
          create: true,
          from: b.name,
        });
      } else {
        await apiCall('projectGit.branchCheckout', { projectId, repoPath, name: b.name });
      }
      toast.success(`Switched to ${b.name}`);
      onMutated();
      onClose();
    } catch (e) {
      toast.error('Checkout failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyAction(null);
    }
  };

  return {
    busyAction,
    onUpdateProject,
    onPush,
    onNewBranch,
    onCheckoutRevision,
    checkout,
  };
}
