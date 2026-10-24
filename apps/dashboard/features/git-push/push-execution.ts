import { type PushDialogRequest } from './push-dialog-store.js';
import type { GitCommitDetail, GitDiffResult, GitIdentityMode, GitPushActionRequired, GitPushPreview, GitRunResult } from '@mcp/api-bus';
import { workspaceApi } from '../builder/preview/api.js';
import { apiCall } from '../../lib/api-client.js';

export async function loadPreview(request: PushDialogRequest): Promise<GitPushPreview> {
  if (request.kind === 'workspace') return workspaceApi.gitPushPreview(request.sessionId, request.projectId);
  return apiCall<GitPushPreview>('projectGit.pushPreview', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    remote: request.remote,
    branch: request.branch,
    setUpstream: request.setUpstream,
  });
}

export async function loadCommit(request: PushDialogRequest, sha: string): Promise<GitCommitDetail> {
  if (request.kind === 'workspace') return workspaceApi.gitCommitDetail(request.sessionId, request.projectId, sha);
  return apiCall<GitCommitDetail>('projectGit.commitDetail', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    sha,
  });
}

export async function loadFileDiff(request: PushDialogRequest, sha: string, path: string): Promise<{ patch: string; truncated?: boolean }> {
  if (request.kind === 'workspace') {
    const result = await workspaceApi.gitCommitFileDiff(request.sessionId, request.projectId, sha, path);
    return { patch: result.diff, truncated: result.truncated };
  }
  return apiCall<GitDiffResult>('projectGit.commitFileDiff', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    sha,
    path,
  });
}

interface PushExecutionResult {
  message: string;
  updatedBeforePush: boolean;
}

function pushError(message: string, code?: GitPushActionRequired): Error {
  const error = new Error(message) as Error & { code?: GitPushActionRequired };
  error.code = code;
  return error;
}

export async function executePush(
  request: PushDialogRequest,
  preview: GitPushPreview,
  pushTags: boolean,
  identityMode: GitIdentityMode,
  managedGrant?: string,
): Promise<PushExecutionResult> {
  if (request.kind === 'workspace') {
    const result = await workspaceApi.gitPush(request.sessionId, request.projectId, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
      pushTags,
    });
    return { message: result.message, updatedBeforePush: result.updatedBeforePush };
  }
  const result = await apiCall<GitRunResult>('projectGit.push', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    remote: preview.remote,
    branch: preview.branch,
    targetBranch: preview.targetBranch,
    expectedHead: preview.headSha,
    setUpstream: preview.setUpstream,
    force: request.force,
    pushTags,
    identityMode,
    managedGrant,
  });
  if (!result.ok) {
    throw pushError(
      result.stderr.trim() || result.stdout.trim() || 'git push failed',
      result.pushActionRequired,
    );
  }
  return {
    message: result.stderr.trim() || result.stdout.trim(),
    updatedBeforePush: result.updatedBeforePush === true,
  };
}
