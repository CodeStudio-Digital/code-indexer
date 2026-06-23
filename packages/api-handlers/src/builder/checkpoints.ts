/**
 * Builder checkpoint handlers: list the timeline, restore a checkpoint
 * (forward-only — `git checkout <sha> -- .` + a new commit, never a
 * reset), and produce a unified diff between two checkpoints.
 *
 * Git runs against the project root with timeouts; failures surface as
 * ApiErrors so the routes map them to clean HTTP responses.
 */
import { execFile } from 'node:child_process';
import { ApiError } from '@mcp/api-bus';
import {
  createBuilderCheckpoint,
  getBuilderCheckpoint,
  listBuilderCheckpoints,
  type BuilderCheckpoint,
} from '@mcp/store/db/builder-checkpoints.js';
import type { HandlerDeps } from '../types.js';

const GIT_TIMEOUT_MS = 20_000;
const DIFF_MAX_CHARS = 800_000;

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

function requireBuilderProject(deps: HandlerDeps, projectId: number) {
  const project = deps.db.getProject(projectId);
  if (!project) throw new ApiError('not_found', 404, 'project not found');
  if (!project.builder_json) throw new ApiError('not_builder', 400, 'project is not a Builder project');
  if (!project.root_path) throw new ApiError('no_root', 400, 'project has no root path');
  return project;
}

export function listCheckpoints(deps: HandlerDeps, projectId: number): BuilderCheckpoint[] {
  requireBuilderProject(deps, projectId);
  return listBuilderCheckpoints(deps.db.projectScopedDb(projectId), projectId);
}

export interface CreateCheckpointInput {
  label: string;
  kind: 'visual' | 'manual';
}

/** Commit the current dirty tree as a checkpoint (no-op on a clean tree). */
export async function createCheckpointNow(
  deps: HandlerDeps,
  projectId: number,
  input: CreateCheckpointInput,
): Promise<{ ok: true; checkpoint: BuilderCheckpoint | null }> {
  const project = requireBuilderProject(deps, projectId);
  const root = project.root_path;
  const status = await git(root, ['status', '--porcelain']);
  if (!status.ok) throw new ApiError('git_failed', 500, `git status failed: ${status.stderr.slice(0, 300)}`);
  if (!status.stdout.trim()) return { ok: true, checkpoint: null };

  const label = (input.label || 'Visual edits').slice(0, 120);
  const add = await git(root, ['add', '-A']);
  if (!add.ok) throw new ApiError('git_failed', 500, 'git add failed');
  const commit = await git(root, ['commit', '-m', `checkpoint: ${label}`]);
  if (!commit.ok) throw new ApiError('git_failed', 500, `git commit failed: ${commit.stderr.slice(0, 300)}`);
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new ApiError('git_failed', 500, 'git rev-parse failed');

  const checkpoint = createBuilderCheckpoint(deps.db.projectScopedDb(projectId), {
    project_id: projectId,
    commit_sha: head.stdout.trim(),
    label,
    kind: input.kind,
  });
  return { ok: true, checkpoint };
}

export interface RestoreResult {
  ok: true;
  restored: BuilderCheckpoint;
  /** Row created for the dirty tree we parked before restoring (if any). */
  preRestore: BuilderCheckpoint | null;
}

export async function restoreCheckpoint(
  deps: HandlerDeps,
  projectId: number,
  checkpointId: number,
): Promise<RestoreResult> {
  const project = requireBuilderProject(deps, projectId);
  const row = getBuilderCheckpoint(deps.db.projectScopedDb(projectId), checkpointId);
  if (!row || row.project_id !== projectId) {
    throw new ApiError('not_found', 404, 'checkpoint not found');
  }
  const root = project.root_path;

  // Park any dirty work first — restores must never destroy edits.
  let preRestore: BuilderCheckpoint | null = null;
  const status = await git(root, ['status', '--porcelain']);
  if (!status.ok) throw new ApiError('git_failed', 500, `git status failed: ${status.stderr.slice(0, 300)}`);
  if (status.stdout.trim()) {
    const add = await git(root, ['add', '-A']);
    const commit = add.ok && (await git(root, ['commit', '-m', 'checkpoint: before restore']));
    if (commit && commit.ok) {
      const head = await git(root, ['rev-parse', 'HEAD']);
      if (head.ok) {
        preRestore = createBuilderCheckpoint(deps.db.projectScopedDb(projectId), {
          project_id: projectId,
          commit_sha: head.stdout.trim(),
          label: 'Before restore',
          kind: 'manual',
        });
      }
    }
  }

  const checkout = await git(root, ['checkout', row.commit_sha, '--', '.']);
  if (!checkout.ok) {
    throw new ApiError('git_failed', 500, `git checkout failed: ${checkout.stderr.slice(0, 300)}`);
  }
  // `checkout <sha> -- .` doesn't delete files created after the
  // checkpoint; that's intentional (non-destructive restore semantics).
  await git(root, ['add', '-A']);
  const commit = await git(root, ['commit', '-m', `checkpoint: restore "${row.label}"`.slice(0, 200)]);
  // A no-op restore (already at that state) leaves nothing to commit.
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new ApiError('git_failed', 500, 'git rev-parse failed after restore');

  const restored = createBuilderCheckpoint(deps.db.projectScopedDb(projectId), {
    project_id: projectId,
    session_id: row.session_id,
    commit_sha: head.stdout.trim(),
    label: `Restore: ${row.label}`.slice(0, 120),
    kind: 'restore',
    // Reuse the source checkpoint's screenshot — same rendered state.
    screenshot_path: commit.ok ? row.screenshot_path : row.screenshot_path,
  });
  return { ok: true, restored, preRestore };
}

export interface CheckpointDiffResult {
  ok: true;
  patch: string;
  truncated: boolean;
  fromSha: string | null;
  toSha: string;
}

/** Unified diff between two checkpoints (or a checkpoint vs its parent). */
export async function checkpointDiff(
  deps: HandlerDeps,
  projectId: number,
  toId: number,
  fromId?: number,
): Promise<CheckpointDiffResult> {
  const project = requireBuilderProject(deps, projectId);
  const to = getBuilderCheckpoint(deps.db.projectScopedDb(projectId), toId);
  if (!to || to.project_id !== projectId) throw new ApiError('not_found', 404, 'checkpoint not found');
  let fromSha: string | null = null;
  if (fromId != null) {
    const from = getBuilderCheckpoint(deps.db.projectScopedDb(projectId), fromId);
    if (!from || from.project_id !== projectId) throw new ApiError('not_found', 404, 'checkpoint not found');
    fromSha = from.commit_sha;
  }

  const range = fromSha ? [`${fromSha}..${to.commit_sha}`] : [`${to.commit_sha}^!`];
  const diff = await git(project.root_path, ['diff', '--no-color', ...range]);
  if (!diff.ok) throw new ApiError('git_failed', 500, `git diff failed: ${diff.stderr.slice(0, 300)}`);
  const truncated = diff.stdout.length > DIFF_MAX_CHARS;
  return {
    ok: true,
    patch: truncated ? diff.stdout.slice(0, DIFF_MAX_CHARS) : diff.stdout,
    truncated,
    fromSha,
    toSha: to.commit_sha,
  };
}
