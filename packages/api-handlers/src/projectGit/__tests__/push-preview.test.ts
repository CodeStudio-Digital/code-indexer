import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProjectGitHandlers } from '../index.js';

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
  const root = mkdtempSync(join(tmpdir(), 'mcp-push-preview-'));
  const remote = mkdtempSync(join(tmpdir(), 'mcp-push-origin-'));
  dirs.push(root, remote);
  git(remote, 'init', '--bare');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Push Tester');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  writeFileSync(join(root, 'tracked.txt'), 'base\noutgoing\n');
  git(root, 'commit', '-am', 'outgoing change');
  git(root, 'tag', '-a', 'release-v1', '-m', 'release v1');
  return { root, remote };
}

function handlers(root: string) {
  return createProjectGitHandlers({
    db: { getProject: (id: number) => id === 1 ? { id, name: 'Push repo', root_path: root } : null },
  } as never);
}

describe('reviewed project push', () => {
  it('previews commits and tags, exposes commit contents, then publishes the reviewed refs', async () => {
    const { root, remote } = setup();
    const api = handlers(root);

    const preview = await api.pushPreview({ projectId: 1 }, {} as never);
    expect(preview).toMatchObject({
      branch: 'main',
      headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      remote: 'origin',
      targetBranch: 'main',
      upstream: 'origin/main',
      setUpstream: false,
      commitCount: 1,
      commitsTruncated: false,
    });
    expect(preview.commits.map((commit) => commit.subject)).toEqual(['outgoing change']);
    expect(preview.tags.map((tag) => tag.name)).toContain('release-v1');

    const detail = await api.commitDetail({ projectId: 1, sha: preview.commits[0].sha }, {} as never);
    expect(detail.subject).toBe('outgoing change');
    expect(detail.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', additions: 1, deletions: 0 }),
    ]));
    const diff = await api.commitFileDiff({ projectId: 1, sha: detail.sha, path: 'tracked.txt' }, {} as never);
    expect(diff.patch).toContain('+outgoing');

    const pushed = await api.push({
      projectId: 1,
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
      pushTags: true,
    }, {} as never);
    expect(pushed.ok).toBe(true);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(remote, 'rev-parse', 'refs/tags/release-v1')).toBe(git(root, 'rev-parse', 'refs/tags/release-v1'));
  });

  it('rejects confirmation when the branch changed after the preview', async () => {
    const { root } = setup();
    const api = handlers(root);
    const preview = await api.pushPreview({ projectId: 1 }, {} as never);
    writeFileSync(join(root, 'after-preview.txt'), 'new tip\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'created after preview');

    await expect(api.push({
      projectId: 1,
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
    }, {} as never)).rejects.toMatchObject({ code: 'git_push_preview_stale', status: 409 });
  });
});
