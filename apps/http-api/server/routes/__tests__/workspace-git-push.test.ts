import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  gitCommitDetail,
  gitCommitFileDiff,
  gitPush,
  gitPushPreview,
} from '../workspace/git-service.js';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
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

describe('reviewed workspace push', () => {
  it('uses the previewed target for commits and optional tags', async () => {
    const { root, remote } = setup();
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
});
