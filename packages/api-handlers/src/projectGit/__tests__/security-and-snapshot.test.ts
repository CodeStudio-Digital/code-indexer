import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createProjectGitHandlers, parsePorcelainV2Status } from '../index.js';
import { guardProjectGitApi, PROJECT_GIT_RPC_METHODS } from '../guard.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end();
  });
}

async function init(root: string, commit = true): Promise<void> {
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  if (commit) {
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'base']);
  }
}

function handlers(projectRoot: string) {
  return createProjectGitHandlers({
    db: { getProjectRootPath: (id: number) => id === 1 ? projectRoot : undefined },
  } as never);
}

describe('project git premium safety and snapshots', () => {
  it('keeps the RPC allowlist in exact parity with the handler surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-contract-'));
    dirs.push(root);
    await init(root);
    expect(Object.keys(handlers(root)).sort()).toEqual([...PROJECT_GIT_RPC_METHODS].sort());
  });

  it('uses one Git process for a warmed summary and records content-free telemetry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-metrics-'));
    dirs.push(root);
    await init(root);
    const rows: Array<Record<string, unknown>> = [];
    const h = createProjectGitHandlers({
      db: { getProjectRootPath: () => root },
      pipelineTelemetryStore: { insert: (row: Record<string, unknown>) => rows.push(row) },
    } as never);
    await h.listRepos({ projectId: 1 }, {} as never);
    rows.length = 0;

    await h.status({ projectId: 1, repoPath: root, includeFiles: false }, {} as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pipeline_name: 'project_git',
      stage: 'status',
      diag: expect.objectContaining({ process_count: 1, timed_out: false, truncated: false }),
    });
    expect(JSON.stringify(rows[0])).not.toContain(root);
  });

  it('cancels diff during target resolution, and reports target and worker times on success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-diff-phases-'));
    dirs.push(root);
    await init(root);
    writeFileSync(join(root, 'base.txt'), 'changed\n');
    let release!: (root: string) => void;
    const pending = new Promise<string>(r => { release = r; });
    const rows: Array<{ diag: Record<string, unknown> }> = [];
    const h = createProjectGitHandlers({ db: { getProjectRootPath: () => pending },
      pipelineTelemetryStore: { insert: (row: typeof rows[number]) => rows.push(row) } } as never);
    const controller = new AbortController();
    const first = h.diff({ projectId: 1, path: 'base.txt' }, { signal: controller.signal } as never);
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'git_diff_cancelled' });
    release(root);
    expect(rows[0]?.diag.process_count).toBe(0);
    const patch = await h.diff({ projectId: 1, path: 'base.txt' }, {} as never);
    expect(patch.patch).toContain('+changed');
    expect(rows[1]?.diag).toMatchObject({ process_count: 2, target_resolve_ms: expect.any(Number),
      git_round_trip_ms: expect.any(Number), git_process_ms: expect.any(Number) });
  });
  it('rejects raw AI argv and never executes an injected git alias', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-ai-safe-'));
    dirs.push(root);
    await init(root);
    const marker = join(root, 'should-not-exist.txt');
    const h = handlers(root);

    await expect(h.aiExecute({
      projectId: 1,
      // Legacy attacker-controlled payload: no planId, plus a shell alias.
      steps: [{ command: 'git', args: ['-c', `alias.pwn=!echo owned>${marker}`, 'pwn'] }],
    } as never, {} as never)).rejects.toMatchObject({ code: 'bad_input', status: 400 });
    expect(existsSync(marker)).toBe(false);
  });

  it('requires explicit consent before sending repository context to AI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-ai-consent-'));
    dirs.push(root);
    await init(root);
    const h = handlers(root);

    await expect(h.aiPlan({ projectId: 1, repoPath: root, intent: 'create a branch' } as never, {} as never))
      .rejects.toMatchObject({ code: 'bad_input', status: 400 });
    await expect(h.aiCommitMessage({ projectId: 1, repoPath: root } as never, {} as never))
      .rejects.toMatchObject({ code: 'bad_input', status: 400 });
  });

  it('unstages files in an unborn repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-unborn-'));
    dirs.push(root);
    await init(root, false);
    writeFileSync(join(root, 'first.txt'), 'first\n');
    await git(root, ['add', 'first.txt']);
    const h = handlers(root);

    await h.unstage({ projectId: 1, repoPath: root, paths: ['first.txt'] }, {} as never);
    expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');
    expect(existsSync(join(root, 'first.txt'))).toBe(true);
  });

  it('discards mixed tracked and untracked paths without deleting tracked content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-discard-'));
    dirs.push(root);
    await init(root);
    writeFileSync(join(root, 'base.txt'), 'changed\n');
    writeFileSync(join(root, 'temporary.txt'), 'temporary\n');
    const h = handlers(root);

    await h.discard({ projectId: 1, repoPath: root, paths: ['base.txt', 'temporary.txt'] }, {} as never);
    expect(existsSync(join(root, 'base.txt'))).toBe(true);
    expect(readFileSync(join(root, 'base.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
    expect(existsSync(join(root, 'temporary.txt'))).toBe(false);
  });

  it('preserves rename and unusual path names in porcelain v2 status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-paths-'));
    dirs.push(root);
    await init(root);
    writeFileSync(join(root, 'old name.txt'), 'old\n');
    await git(root, ['add', 'old name.txt']);
    await git(root, ['commit', '-m', 'path base']);
    await git(root, ['mv', 'old name.txt', 'novo café.txt']);
    const oddPath = 'espaço café.txt';
    writeFileSync(join(root, oddPath), 'odd\n');
    const h = handlers(root);

    const status = await h.statusPage({ projectId: 1, repoPath: root }, {} as never);
    expect(status.files).toContainEqual(expect.objectContaining({
      path: 'novo café.txt',
      oldPath: 'old name.txt',
      state: 'renamed',
    }));
    expect(status.files).toContainEqual(expect.objectContaining({ path: oddPath, state: 'untracked' }));

    // Windows cannot create control characters in file names, so exercise the
    // NUL-delimited parser directly for the portable Git contract.
    const newlinePath = 'tab\tline\nbreak.txt';
    const parsed = parsePorcelainV2Status(`? ${newlinePath}\0u UU N... 100644 100644 100644 100644 a b c conflict name.txt\0`);
    expect(parsed.files).toContainEqual({ path: newlinePath, state: 'untracked', staged: false });
    expect(parsed.files.filter((file) => file.path === 'conflict name.txt')).toHaveLength(1);
  });

  it('serves a stable progressive status snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-pages-'));
    dirs.push(root);
    await init(root);
    for (let i = 0; i < 275; i += 1) writeFileSync(join(root, `new-${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    const h = handlers(root);

    const first = await h.statusPage({ projectId: 1, repoPath: root, pageSize: 250 }, {} as never);
    expect(first.files).toHaveLength(250);
    expect(first.counts.total).toBe(275);
    expect(first.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.nextCursor).toBe('250');

    const second = await h.statusPage({ projectId: 1, repoPath: root, pageSize: 250, snapshotId: first.snapshotId!, cursor: first.nextCursor! }, {} as never);
    expect(second.files).toHaveLength(25);
    expect(second.nextCursor).toBeNull();
    const allFiles = [...first.files, ...second.files];
    expect(new Set(allFiles.map((file) => file.path)).size).toBe(275);

    // Bulk mutations use a NUL-delimited pathspec stream instead of hundreds of
    // argv entries, which is both faster and safe from Windows command limits.
    const allPaths = allFiles.map((file) => file.path);
    await h.stage({ projectId: 1, repoPath: root, paths: allPaths }, {} as never);
    expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim().split(/\r?\n/)).toHaveLength(275);
    await h.unstage({ projectId: 1, repoPath: root, paths: allPaths }, {} as never);
    expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');
  });

  it('gives bulk stage and commit foreground priority over background indexing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-priority-'));
    dirs.push(root);
    await init(root);
    writeFileSync(join(root, 'foreground.txt'), 'foreground\n');
    const leases: string[] = [];
    const h = createProjectGitHandlers({
      db: { getProjectRootPath: () => root },
      projectIndexService: {
        async withInteractiveFilesystemPriority<T>(_projectId: number, fn: () => Promise<T>) {
          leases.push('begin');
          try {
            return await fn();
          } finally {
            leases.push('end');
          }
        },
      },
    } as never);

    await h.stage({ projectId: 1, repoPath: root, paths: ['foreground.txt'] }, {} as never);
    await h.commit({ projectId: 1, repoPath: root, message: 'foreground', amend: false }, {} as never);
    expect(leases).toEqual(['begin', 'end', 'begin', 'end']);
  });

  it('pins history pages to the original HEAD when new commits arrive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-history-'));
    dirs.push(root);
    await init(root);
    for (let i = 1; i <= 4; i += 1) {
      writeFileSync(join(root, `commit-${i}.txt`), `${i}\n`);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', `commit ${i}`]);
    }
    const h = handlers(root);
    const first = await h.logPage({ projectId: 1, repoPath: root, pageSize: 2 }, {} as never);
    expect(first.commits).toHaveLength(2);
    expect(first.snapshotId).toBeTruthy();
    expect(first.nextCursor).toBe('2');

    writeFileSync(join(root, 'new-head.txt'), 'new\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'new head']);
    const newHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const second = await h.logPage({
      projectId: 1,
      repoPath: root,
      pageSize: 2,
      snapshotId: first.snapshotId!,
      cursor: first.nextCursor!,
    }, {} as never);
    const combined = [...first.commits, ...second.commits].map((commit) => commit.sha);
    expect(combined).not.toContain(newHead);
    expect(new Set(combined).size).toBe(combined.length);
  });

  it('exposes parent-repository scope and marks files outside the project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-parent-'));
    dirs.push(root);
    await init(root);
    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'inside.txt'), 'inside\n');
    writeFileSync(join(root, 'outside.txt'), 'outside\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'scope']);
    writeFileSync(join(project, 'inside.txt'), 'changed\n');
    writeFileSync(join(root, 'outside.txt'), 'changed\n');
    const h = handlers(project);

    const repos = await h.listRepos({ projectId: 1 }, {} as never);
    expect(repos[0]).toMatchObject({ projectRoot: project, extendsBeyondProject: true });
    expect(repos[0].absPath.replace(/\\/g, '/')).toBe(root.replace(/\\/g, '/'));
    const status = await h.statusPage({ projectId: 1, repoPath: root }, {} as never);
    expect(status.files.find((file) => file.path === 'outside.txt')?.outsideProject).toBe(true);
    expect(status.files.find((file) => file.path === 'project/inside.txt')?.outsideProject).not.toBe(true);
  });

  it('rejects path traversal before spawning git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-git-path-'));
    dirs.push(root);
    await init(root);
    await expect(handlers(root).stage({ projectId: 1, repoPath: root, paths: ['../escape.txt'] }, {} as never))
      .rejects.toMatchObject({ code: 'bad_input', status: 400 });
  });

  it('serializes mutations that target the same repository scope', async () => {
    let active = 0;
    let maxActive = 0;
    const target = new Proxy({}, {
      get: () => async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { ok: true };
      },
    });
    const guarded = guardProjectGitApi(target as never);

    await Promise.all([
      guarded.stage({ projectId: 1, repoPath: 'repo', paths: ['a.txt'] }, {} as never),
      guarded.unstage({ projectId: 1, repoPath: 'repo', paths: ['b.txt'] }, {} as never),
    ]);
    expect(maxActive).toBe(1);
  });
});
