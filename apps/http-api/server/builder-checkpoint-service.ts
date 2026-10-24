import { execFile } from 'node:child_process';
import { ApiError } from '@mcp/api-bus';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import type { CatalogEntry } from '@mcp/session-storage';
import {
  createBuilderCheckpointFile,
  findBuilderCheckpointFile,
  listBuilderCheckpointFiles,
  readBuilderCheckpointThumbnail,
  resolveBuilderCheckpointOwner,
  type BuilderCheckpoint,
  type BuilderCheckpointKind,
} from '../builder-checkpoint-files.js';
import type { ServerDeps } from './deps.js';

const GIT_TIMEOUT_MS = 20_000;
const DIFF_MAX_CHARS = 800_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        untrack();
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    const untrack = trackProcessTree(child.pid);
  });
}

function requireBuilderProject(deps: ServerDeps, projectId: number) {
  const project = deps.db.getProject(projectId);
  if (!project) {
    throw new ApiError('not_found', 404, 'project not found');
  }
  if (!project.builder_json) {
    throw new ApiError(
      'not_builder',
      400,
      'project is not a Builder project',
    );
  }
  if (!project.root_path) {
    throw new ApiError('no_root', 400, 'project has no root path');
  }
  return project;
}

async function requireCheckpoint(
  deps: ServerDeps,
  projectId: number,
  checkpointId: string,
) {
  const located = await findBuilderCheckpointFile(
    deps.sessionStore,
    projectId,
    checkpointId,
  );
  if (!located) {
    throw new ApiError('not_found', 404, 'checkpoint not found');
  }
  return located;
}

async function requireOwner(
  deps: ServerDeps,
  projectId: number,
  requestedSessionId?: string,
): Promise<CatalogEntry> {
  const entry = await resolveBuilderCheckpointOwner(
    deps.sessionStore,
    projectId,
    requestedSessionId,
  );
  if (!entry) {
    throw new ApiError(
      'session_bundle_required',
      409,
      requestedSessionId
        ? 'session does not exist or is not linked to this project'
        : 'no active coder session bundle is available for this project',
    );
  }
  return entry;
}

async function commitDirtyTree(
  root: string,
  message: string,
): Promise<string | null> {
  const status = await git(root, ['status', '--porcelain']);
  if (!status.ok) {
    throw new ApiError(
      'git_failed',
      500,
      `git status failed: ${status.stderr.slice(0, 300)}`,
    );
  }
  if (!status.stdout.trim()) return null;

  const add = await git(root, ['add', '-A']);
  if (!add.ok) {
    throw new ApiError('git_failed', 500, 'git add failed');
  }
  const commit = await git(root, ['commit', '-m', message.slice(0, 200)]);
  if (!commit.ok) {
    throw new ApiError(
      'git_failed',
      500,
      `git commit failed: ${commit.stderr.slice(0, 300)}`,
    );
  }
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    throw new ApiError('git_failed', 500, 'git rev-parse failed');
  }
  return head.stdout.trim();
}

export async function listCheckpoints(
  deps: ServerDeps,
  projectId: number,
): Promise<BuilderCheckpoint[]> {
  requireBuilderProject(deps, projectId);
  return listBuilderCheckpointFiles(deps.sessionStore, projectId);
}

interface CreateCheckpointInput {
  label: string;
  kind: Extract<BuilderCheckpointKind, 'visual' | 'manual'>;
  session_id?: string;
}

export async function createCheckpointNow(
  deps: ServerDeps,
  projectId: number,
  input: CreateCheckpointInput,
): Promise<{ ok: true; checkpoint: BuilderCheckpoint | null }> {
  const project = requireBuilderProject(deps, projectId);
  // Resolve the filesystem authority before touching git. A missing or
  // unavailable session root must never leave an untracked checkpoint commit.
  const entry = await requireOwner(deps, projectId, input.session_id);
  const label = (input.label || 'Visual edits').slice(0, 120);
  const commitSha = await commitDirtyTree(
    project.root_path,
    `checkpoint: ${label}`,
  );
  if (!commitSha) return { ok: true, checkpoint: null };

  const created = await createBuilderCheckpointFile(
    deps.sessionStore,
    entry,
    {
      project_id: projectId,
      commit_sha: commitSha,
      label,
      kind: input.kind,
    },
  );
  return { ok: true, checkpoint: created.checkpoint };
}

interface RestoreResult {
  ok: true;
  restored: BuilderCheckpoint;
  preRestore: BuilderCheckpoint | null;
}

export async function restoreCheckpoint(
  deps: ServerDeps,
  projectId: number,
  checkpointId: string,
): Promise<RestoreResult> {
  const project = requireBuilderProject(deps, projectId);
  const source = await requireCheckpoint(deps, projectId, checkpointId);
  const root = project.root_path;

  const parkedSha = await commitDirtyTree(root, 'checkpoint: before restore');
  const preRestore = parkedSha
    ? (
        await createBuilderCheckpointFile(
          deps.sessionStore,
          source.entry,
          {
            project_id: projectId,
            commit_sha: parkedSha,
            label: 'Before restore',
            kind: 'manual',
          },
        )
      ).checkpoint
    : null;

  const checkout = await git(root, [
    'checkout',
    source.checkpoint.commit_sha,
    '--',
    '.',
  ]);
  if (!checkout.ok) {
    throw new ApiError(
      'git_failed',
      500,
      `git checkout failed: ${checkout.stderr.slice(0, 300)}`,
    );
  }
  const add = await git(root, ['add', '-A']);
  if (!add.ok) {
    throw new ApiError('git_failed', 500, 'git add failed after restore');
  }
  const commit = await git(root, [
    'commit',
    '-m',
    `checkpoint: restore "${source.checkpoint.label}"`.slice(0, 200),
  ]);
  if (!commit.ok) {
    const status = await git(root, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim()) {
      throw new ApiError(
        'git_failed',
        500,
        `git commit failed after restore: ${commit.stderr.slice(0, 300)}`,
      );
    }
  }
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    throw new ApiError(
      'git_failed',
      500,
      'git rev-parse failed after restore',
    );
  }

  const restored = await createBuilderCheckpointFile(
    deps.sessionStore,
    source.entry,
    {
      project_id: projectId,
      commit_sha: head.stdout.trim(),
      label: `Restore: ${source.checkpoint.label}`.slice(0, 120),
      kind: 'restore',
      screenshot: source.checkpoint.screenshot,
    },
  );
  return {
    ok: true,
    restored: restored.checkpoint,
    preRestore,
  };
}

interface CheckpointDiffResult {
  ok: true;
  patch: string;
  truncated: boolean;
  fromSha: string | null;
  toSha: string;
}

export async function checkpointDiff(
  deps: ServerDeps,
  projectId: number,
  toId: string,
  fromId?: string,
): Promise<CheckpointDiffResult> {
  const project = requireBuilderProject(deps, projectId);
  const to = await requireCheckpoint(deps, projectId, toId);
  const from =
    fromId == null
      ? null
      : await requireCheckpoint(deps, projectId, fromId);
  const fromSha = from?.checkpoint.commit_sha ?? null;
  const range = fromSha
    ? [`${fromSha}..${to.checkpoint.commit_sha}`]
    : [`${to.checkpoint.commit_sha}^!`];
  const diff = await git(project.root_path, [
    'diff',
    '--no-color',
    ...range,
  ]);
  if (!diff.ok) {
    throw new ApiError(
      'git_failed',
      500,
      `git diff failed: ${diff.stderr.slice(0, 300)}`,
    );
  }
  const truncated = diff.stdout.length > DIFF_MAX_CHARS;
  return {
    ok: true,
    patch: truncated
      ? diff.stdout.slice(0, DIFF_MAX_CHARS)
      : diff.stdout,
    truncated,
    fromSha,
    toSha: to.checkpoint.commit_sha,
  };
}

export async function checkpointThumbnail(
  deps: ServerDeps,
  projectId: number,
  checkpointId: string,
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  requireBuilderProject(deps, projectId);
  const located = await findBuilderCheckpointFile(
    deps.sessionStore,
    projectId,
    checkpointId,
  );
  return located ? readBuilderCheckpointThumbnail(located) : null;
}
