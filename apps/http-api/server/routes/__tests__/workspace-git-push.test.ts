import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  gitCommitDetail,
  gitCommitFileDiff,
  gitPush,
  gitPushPreview,
} from '../workspace/git-service.js';

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function setup(): { root: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workspace-push-'));
  const remote = mkdtempSync(join(tmpdir(), 'mcp-workspace-origin-'));
  dirs.push(root, remote);
  git(remote, 'init', '--bare');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Workspace Tester');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'workspace.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  writeFileSync(join(root, 'workspace.txt'), 'base\nreview me\n');
  git(root, 'commit', '-am', 'workspace outgoing');
  git(root, 'tag', 'workspace-v1');
  return { root, remote };
}

function advanceRemote(remote: string, file: string, contents: string): string {
  const other = mkdtempSync(join(tmpdir(), 'mcp-workspace-collaborator-'));
  dirs.push(other);
  git(other, 'clone', '--branch', 'main', remote, '.');
  git(other, 'config', 'user.email', 'collaborator@example.com');
  git(other, 'config', 'user.name', 'Remote Collaborator');
  git(other, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(other, file), contents);
  git(other, 'add', file);
  git(other, 'commit', '-m', 'remote workspace change');
  git(other, 'push', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

// Real local Git integration: fixture setup has its own process-startup budget.
describe('reviewed workspace push', { timeout: 60_000 }, () => {
  let fixture: ReturnType<typeof setup>;
  beforeEach(() => { fixture = setup(); }, 60_000);
  it('uses the previewed target for commits and optional tags', async () => {
    const { root, remote } = fixture;
    const preview = await gitPushPreview(root);
    expect(preview.commitCount).toBe(1);
    expect(preview.commits[0].subject).toBe('workspace outgoing');
    expect(preview.tags.map((tag) => tag.name)).toContain('workspace-v1');

    const detail = await gitCommitDetail(root, preview.commits[0].sha);
    expect(detail.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'workspace.txt', additions: 1 }),
    ]));
    const diff = await gitCommitFileDiff(root, detail.sha, 'workspace.txt');
    expect(diff).toMatchObject({ truncated: false });
    expect(diff.diff).toContain('+review me');

    const pushed = await gitPush(root, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
      pushTags: true,
    });
    expect(pushed.ok).toBe(true);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(remote, 'rev-parse', 'refs/tags/workspace-v1')).toBe(git(root, 'rev-parse', 'refs/tags/workspace-v1'));
  });

  it('updates a stale local branch with rebase and retries the push', async () => {
    const { root, remote } = fixture;
    const remoteHead = advanceRemote(remote, 'remote-workspace.txt', 'remote work\n');
    const preview = await gitPushPreview(root);

    const pushed = await gitPush(root, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
    });

    expect(pushed).toMatchObject({ ok: true, updatedBeforePush: true });
    expect(git(root, 'merge-base', '--is-ancestor', remoteHead, 'HEAD')).toBe('');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'show', 'HEAD:workspace.txt')).toContain('review me');
  });

  it('keeps a conflicting rebase for resolution and does not retry the push', async () => {
    const { root, remote } = fixture;
    advanceRemote(remote, 'workspace.txt', 'base\nremote version\n');
    const preview = await gitPushPreview(root);

    const pushed = await gitPush(root, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
    });

    expect(pushed).toMatchObject({ ok: false, pushActionRequired: 'git_push_conflicts' });
    expect(git(root, 'diff', '--name-only', '--diff-filter=U')).toBe('workspace.txt');
    expect(git(remote, 'show', 'main:workspace.txt')).toContain('remote version');
  });
});
