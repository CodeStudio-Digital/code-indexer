import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, type ProjectGitApi } from '@mcp/api-bus';

export const PROJECT_GIT_RPC_METHODS = [
  'listRepos', 'status', 'statusPage', 'diff', 'baseline', 'stageHunk', 'log', 'logPage',
  'commitDetail', 'commitFileDiff', 'branchDiff', 'stage', 'unstage', 'discard',
  'commit', 'branchList', 'branchCheckout', 'branchesDetailed', 'branchCreate',
  'branchDelete', 'branchRename', 'merge', 'rebase', 'reset', 'revert',
  'cherryPick', 'mergeState', 'conflictFile', 'resolveConflict', 'mergeContinue',
  'mergeAbort', 'gitOptimizations', 'configureGitOptimizations', 'pushPreview', 'push', 'fetch',
  'pull', 'updateBranch', 'stashList', 'stashSave', 'stashPop', 'stashApply',
  'stashDrop', 'stashShow', 'stashDetail', 'stashFileDiff', 'aiPlan', 'aiExecute',
  'aiCommitMessage', 'detectRemote',
] as const satisfies readonly (keyof ProjectGitApi)[];

export type ProjectGitRpcMethod = (typeof PROJECT_GIT_RPC_METHODS)[number];

interface GitOperationMetrics {
  processCount: number;
  outputBytes: number;
  cacheHits: number;
  cacheMisses: number;
  timedOut: boolean;
  truncated: boolean;
}

const operationMetrics = new AsyncLocalStorage<GitOperationMetrics>();

/** Runner/cache instrumentation without refs, paths, commands or content. */
export function recordGitProcess(metric: { outputBytes: number; timedOut?: boolean; truncated?: boolean }): void {
  const current = operationMetrics.getStore();
  if (!current) return;
  current.processCount += 1;
  current.outputBytes += metric.outputBytes;
  current.timedOut ||= metric.timedOut === true;
  current.truncated ||= metric.truncated === true;
}

export function recordGitCacheDecision(hit: boolean): void {
  const current = operationMetrics.getStore();
  if (!current) return;
  if (hit) current.cacheHits += 1;
  else current.cacheMisses += 1;
}

export const PROJECT_GIT_MUTATIONS = new Set<ProjectGitRpcMethod>([
  'stageHunk', 'stage', 'unstage', 'discard', 'commit', 'branchCheckout',
  'branchCreate', 'branchDelete', 'branchRename', 'merge', 'rebase', 'reset',
  'revert', 'cherryPick', 'resolveConflict', 'mergeContinue', 'mergeAbort',
  'configureGitOptimizations', 'push', 'fetch', 'pull', 'updateBranch',
  'stashSave', 'stashPop', 'stashApply', 'stashDrop', 'aiExecute',
]);

const PATH_KEYS = ['path'] as const;
const REF_KEYS = ['sha', 'branch', 'targetBranch', 'expectedHead', 'name', 'oldName', 'newName', 'from', 'onto', 'target', 'commit'] as const;
const MAX_PATHS = 2_000;
const MAX_PATH_LENGTH = 4_096;
const MAX_REF_LENGTH = 1_024;
const MAX_MESSAGE_LENGTH = 128 * 1024;

function bad(message: string): never {
  throw new ApiError('bad_input', 400, message);
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('git input must be an object');
  return input as Record<string, unknown>;
}

function validateRelativePath(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || value.includes('\0')) {
    bad(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    bad(`${label} must not be absolute`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    bad(`${label} must stay inside the selected repository`);
  }
}

function validateRef(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string' || !value || value.length > MAX_REF_LENGTH ||
    value.includes('\0') || value.startsWith('-')
  ) {
    bad(`${label} is not a valid git reference`);
  }
}

export function validateProjectGitInput(method: ProjectGitRpcMethod, input: unknown): void {
  const value = record(input);
  const projectId = value.projectId;
  if (!Number.isSafeInteger(projectId) || Number(projectId) <= 0) bad('projectId must be a positive integer');

  if (value.repoPath !== undefined) {
    if (typeof value.repoPath !== 'string' || !value.repoPath || value.repoPath.length > MAX_PATH_LENGTH || value.repoPath.includes('\0')) {
      bad('repoPath is invalid');
    }
  }

  for (const key of PATH_KEYS) {
    if (value[key] !== undefined) validateRelativePath(value[key], key);
  }
  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths) || value.paths.length > MAX_PATHS) bad(`paths must contain at most ${MAX_PATHS} entries`);
    for (let i = 0; i < value.paths.length; i += 1) validateRelativePath(value.paths[i], `paths[${i}]`);
  }
  for (const key of REF_KEYS) validateRef(value[key], key);
  if (value.commits !== undefined) {
    if (!Array.isArray(value.commits) || value.commits.length === 0 || value.commits.length > 100) {
      bad('commits must contain between 1 and 100 references');
    }
    for (let i = 0; i < value.commits.length; i += 1) validateRef(value.commits[i], `commits[${i}]`);
  }

  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE_LENGTH)) {
    bad(`message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  if (method === 'commit' && (typeof value.message !== 'string' || !value.message.trim())) bad('commit message required');
  if (method === 'aiPlan' && (typeof value.intent !== 'string' || !value.intent.trim() || value.intent.length > 2_000)) {
    bad('intent must contain between 1 and 2000 characters');
  }
  if ((method === 'aiPlan' || method === 'aiCommitMessage') && value.consent !== true) {
    bad('explicit AI context consent is required');
  }
  if (method === 'aiExecute' && (typeof value.planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.planId))) {
    bad('a valid planId is required');
  }
  if (method === 'statusPage') {
    if (value.pageSize !== undefined && (!Number.isFinite(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 1_000)) {
      bad('pageSize must be between 1 and 1000');
    }
    if (value.snapshotId !== undefined && (typeof value.snapshotId !== 'string' || value.snapshotId.length > 100)) bad('snapshotId is invalid');
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || !/^\d+$/.test(value.cursor))) bad('cursor is invalid');
  }
  if (method === 'log') {
    if (value.limit !== undefined && (!Number.isFinite(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 500)) bad('limit must be between 1 and 500');
    if (value.skip !== undefined && (!Number.isFinite(value.skip) || Number(value.skip) < 0 || Number(value.skip) > 1_000_000)) bad('skip is invalid');
  }
  if (method === 'logPage') {
    if (value.pageSize !== undefined && (!Number.isFinite(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 500)) bad('pageSize must be between 1 and 500');
    if (value.snapshotId !== undefined && (typeof value.snapshotId !== 'string' || value.snapshotId.length > 100)) bad('snapshotId is invalid');
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || !/^\d+$/.test(value.cursor))) bad('cursor is invalid');
  }
  if (method === 'reset' && !['soft', 'mixed', 'hard'].includes(String(value.mode))) bad('reset mode is invalid');
  if (method === 'resolveConflict') {
    const resolution = value.resolution;
    const valid = resolution === 'ours' || resolution === 'theirs' || (
      !!resolution && typeof resolution === 'object' && !Array.isArray(resolution) &&
      typeof (resolution as { content?: unknown }).content === 'string' &&
      (resolution as { content: string }).content.length <= 16 * 1024 * 1024
    );
    if (!valid) bad('conflict resolution is invalid or too large');
  }
}

/** Validate every transport and serialize mutations per repository scope. */
export function guardProjectGitApi(
  api: ProjectGitApi,
  onMutation?: (method: ProjectGitRpcMethod, input: { projectId: number; repoPath?: string }) => void,
  onMetric?: (metric: {
    method: ProjectGitRpcMethod;
    durationMs: number;
    queueWaitMs: number;
    mutation: boolean;
    ok: boolean;
    processCount: number;
    outputBytes: number;
    cacheHits: number;
    cacheMisses: number;
    timedOut: boolean;
    truncated: boolean;
  }) => void,
): ProjectGitApi {
  const tails = new Map<string, Promise<unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const method of PROJECT_GIT_RPC_METHODS) {
    const target = api[method] as unknown as (input: unknown, ctx: unknown) => Promise<unknown>;
    wrapped[method] = async (input: unknown, ctx: unknown) => {
      const startedAt = Date.now();
      const stats: GitOperationMetrics = {
        processCount: 0,
        outputBytes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        timedOut: false,
        truncated: false,
      };
      const execute = () => operationMetrics.run(stats, () => target(input, ctx));
      const emit = (ok: boolean, mutation: boolean, queueWaitMs: number) => onMetric?.({
        method,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        mutation,
        ok,
        ...stats,
      });
      validateProjectGitInput(method, input);
      if (!PROJECT_GIT_MUTATIONS.has(method)) {
        try {
          const result = await execute();
          emit(true, false, 0);
          return result;
        } catch (error) {
          emit(false, false, 0);
          throw error;
        }
      }
      const value = input as { projectId: number; repoPath?: string };
      const key = `${value.projectId}:${value.repoPath ?? '<project>'}`;
      const previous = tails.get(key) ?? Promise.resolve();
      let queueWaitMs = 0;
      const current = previous.catch(() => undefined).then(() => {
        queueWaitMs = Date.now() - startedAt;
        return execute();
      });
      tails.set(key, current);
      try {
        const result = await current;
        onMutation?.(method, value);
        emit(true, true, queueWaitMs);
        return result;
      } catch (error) {
        emit(false, true, queueWaitMs);
        throw error;
      } finally {
        if (tails.get(key) === current) tails.delete(key);
      }
    };
  }
  return wrapped as unknown as ProjectGitApi;
}
