/**
 * Tests for the IntelliJ branch ops added in the perf/UX overhaul: a rebase
 * conflict surfaces through mergeState (kind 'rebase') and aborts cleanly;
 * branchDiff returns a real patch; branchesDetailed caches by git-revision
 * (same rev → same object + zero git spawn; new rev → recompute). Real git in
 * a temp repo, no DB — mirrors status.test.ts.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitSpawnStats = vi.hoisted(() => ({ forEachRef: 0 }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn(command: string, args?: readonly string[], options?: unknown) {
      if (command === 'git' && Array.isArray(args) && args[0] === 'for-each-ref') {
        gitSpawnStats.forEachRef += 1;
      }
      return actual.spawn(command, args, options as never);
    },
  };
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const { createProjectGitHandlers } = await import('../index.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

async function runGit(cwd: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString('utf8') || `git ${args.join(' ')} failed`)),
    );
    child.stdin.end();
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { spawn } = await import('node:child_process');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString('utf8').trim())
        : reject(new Error(Buffer.concat(stderr).toString('utf8') || `git ${args.join(' ')} failed`)),
    );
    child.stdin.end();
  });
}

function makeHandlers(root: string) {
  return createProjectGitHandlers({
    db: { getProjectRootPath: (id: number) => (id === 1 ? root : undefined) },
  } as never);
}

/** main and feature diverge on the SAME line so a rebase of feature onto main conflicts. */
async function setupDivergingRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-rebase-'));
  dirs.push(dir);
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 't@example.com']);
  await runGit(dir, ['config', 'user.name', 'Tester']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'file.txt'), 'a\nshared\nz\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'base']);
  await runGit(dir, ['checkout', '-b', 'feature']);
  writeFileSync(join(dir, 'file.txt'), 'a\nFEATURE\nz\n');
  await runGit(dir, ['commit', '-am', 'feature change']);
  await runGit(dir, ['checkout', 'main']);
  writeFileSync(join(dir, 'file.txt'), 'a\nMAIN\nz\n');
  await runGit(dir, ['commit', '-am', 'main change']);
  await runGit(dir, ['checkout', 'feature']);
  return dir;
}

describe('branch ops', () => {
  it('checks out a remote ref as a local tracking branch and permits re-selection', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'mcp-checkout-origin-'));
    const work = mkdtempSync(join(tmpdir(), 'mcp-checkout-work-'));
    dirs.push(origin, work);

    await runGit(origin, ['init', '-b', 'main']);
    await runGit(origin, ['config', 'user.email', 't@example.com']);
    await runGit(origin, ['config', 'user.name', 'Tester']);
    await runGit(origin, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(origin, 'file.txt'), 'base\n');
    await runGit(origin, ['add', '.']);
    await runGit(origin, ['commit', '-m', 'base']);
    await runGit(origin, ['checkout', '-b', 'feature/remote-checkout']);
    writeFileSync(join(origin, 'file.txt'), 'remote tip\n');
    await runGit(origin, ['commit', '-am', 'remote tip']);
    await runGit(origin, ['checkout', 'main']);

    await runGit(tmpdir(), ['clone', origin, work]);
    // Prove the handler establishes tracking explicitly rather than relying on
    // the user's branch.autoSetupMerge configuration.
    await runGit(work, ['config', 'branch.autoSetupMerge', 'false']);
    const h = makeHandlers(work);

    await h.branchCheckout({
      projectId: 1,
      name: 'feature/remote-checkout',
      create: true,
      from: 'origin/feature/remote-checkout',
    }, {} as never);

    expect(await gitOutput(work, ['branch', '--show-current'])).toBe('feature/remote-checkout');
    expect(await gitOutput(work, ['rev-parse', 'HEAD'])).toBe(
      await gitOutput(work, ['rev-parse', 'origin/feature/remote-checkout']),
    );
    expect(await gitOutput(work, ['rev-parse', '--abbrev-ref', '@{upstream}']))
      .toBe('origin/feature/remote-checkout');

    await runGit(work, ['checkout', 'main']);
    await expect(h.branchCheckout({
      projectId: 1,
      name: 'feature/remote-checkout',
      create: true,
      from: 'origin/feature/remote-checkout',
    }, {} as never)).resolves.toEqual({ ok: true });
    expect(await gitOutput(work, ['branch', '--show-current'])).toBe('feature/remote-checkout');
  });

  it('log pagina commits com limit + skip sem repetir a pagina anterior', async () => {
    const dir = await setupDivergingRepo();
    const h = makeHandlers(dir);

    const first = await h.log({ projectId: 1, branch: 'feature', limit: 1, skip: 0 }, {} as never);
    const second = await h.log({ projectId: 1, branch: 'feature', limit: 1, skip: 1 }, {} as never);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].sha).not.toBe(first[0].sha);
    expect(first[0].parents).toHaveLength(1);
    expect(first[0].refs).toContain('HEAD -> feature');
  });

  it('log --all exposes diverged refs and topology without increasing the page size', async () => {
    const dir = await setupDivergingRepo();
    const h = makeHandlers(dir);

    const page = await h.log({ projectId: 1, all: true, limit: 3 }, {} as never);

    expect(page).toHaveLength(3);
    expect(page.map((entry) => entry.subject)).toEqual(
      expect.arrayContaining(['feature change', 'main change', 'base']),
    );
    expect(page.find((entry) => entry.subject === 'feature change')?.parents).toHaveLength(1);
    expect(page.find((entry) => entry.subject === 'main change')?.refs).toContain('main');
  });

  it('rebase onto a diverged branch conflicts → mergeState kind=rebase → abort cleans up', async () => {
    const dir = await setupDivergingRepo();
    const h = makeHandlers(dir);

    const r = await h.rebase({ projectId: 1, onto: 'main' }, {} as never);
    expect(r.ok).toBe(false); // stopped on conflict (non-interactive, did NOT hang)

    const state = await h.mergeState({ projectId: 1 }, {} as never);
    expect(state.kind).toBe('rebase');
    expect(state.conflictedFiles).toContain('file.txt');

    const abort = await h.mergeAbort({ projectId: 1 }, {} as never);
    expect(abort.ok).toBe(true);
    const after = await h.mergeState({ projectId: 1 }, {} as never);
    expect(after.kind).toBeNull();
  });

  it('branchDiff returns a non-empty patch comparing another branch with current', async () => {
    const dir = await setupDivergingRepo(); // currently on feature
    const h = makeHandlers(dir);
    const { patch } = await h.branchDiff({ projectId: 1, branch: 'main' }, {} as never);
    expect(patch).toMatch(/^diff --git/m);
    expect(patch).toContain('file.txt');
  });

  it('branchesDetailed caches by rev: same rev → same object + no spawn; new rev → recompute', async () => {
    const dir = await setupDivergingRepo();
    const h = makeHandlers(dir);

    gitSpawnStats.forEachRef = 0;
    const r1 = await h.branchesDetailed({ projectId: 1, rev: 1 }, {} as never);
    const r2 = await h.branchesDetailed({ projectId: 1, rev: 1 }, {} as never);
    expect(r2).toBe(r1); // cache hit returns the SAME array reference
    expect(gitSpawnStats.forEachRef).toBe(1); // second call spawned nothing

    const r3 = await h.branchesDetailed({ projectId: 1, rev: 2 }, {} as never);
    expect(r3).not.toBe(r1); // new rev recomputes
    expect(gitSpawnStats.forEachRef).toBe(2);

    // Sanity: the data is real (main + feature present).
    expect(r1.map((b) => b.name)).toEqual(expect.arrayContaining(['main', 'feature']));
  });

  it('branchesDetailed without rev does not cache (always recomputes)', async () => {
    const dir = await setupDivergingRepo();
    const h = makeHandlers(dir);
    const a = await h.branchesDetailed({ projectId: 1 }, {} as never);
    const b = await h.branchesDetailed({ projectId: 1 }, {} as never);
    expect(b).not.toBe(a); // no rev → no cache key → fresh array each time
  });
});

describe('updateBranch (fast-forward a non-current branch from its upstream)', () => {
  /** Trimmed stdout of a git command (the suite's runGit returns void). */
  function out(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd, windowsHide: true });
      const b: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => b.push(c));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(Buffer.concat(b).toString('utf8').trim()));
    });
  }

  /** An origin repo + a clone whose `main` tracks origin/main but is behind. */
  async function setupBehindClone(): Promise<{ work: string; originHead: string }> {
    const origin = mkdtempSync(join(tmpdir(), 'mcp-origin-'));
    const work = mkdtempSync(join(tmpdir(), 'mcp-work-')); // empty → git clones into it
    dirs.push(origin, work);
    await runGit(origin, ['init', '-b', 'main']);
    await runGit(origin, ['config', 'user.email', 't@example.com']);
    await runGit(origin, ['config', 'user.name', 'Tester']);
    await runGit(origin, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(origin, 'f.txt'), 'A\n');
    await runGit(origin, ['add', '.']);
    await runGit(origin, ['commit', '-m', 'A']);
    await runGit(tmpdir(), ['clone', origin, work]); // work.main tracks origin/main
    await runGit(work, ['config', 'user.email', 't@example.com']);
    await runGit(work, ['config', 'user.name', 'Tester']);
    await runGit(work, ['checkout', '-b', 'other']); // main is now NON-current
    writeFileSync(join(origin, 'f.txt'), 'A\nB\n');
    await runGit(origin, ['commit', '-am', 'B']); // origin advances (A → B, a ff)
    return { work, originHead: await out(origin, ['rev-parse', 'main']) };
  }

  it('fast-forwards a non-current local branch to its upstream without checkout', async () => {
    const { work, originHead } = await setupBehindClone();
    const h = makeHandlers(work);
    const before = await out(work, ['rev-parse', 'main']);
    expect(before).not.toBe(originHead); // sanity: the clone is behind

    const r = await h.updateBranch({ projectId: 1, branch: 'main' }, {} as never);
    expect(r.ok).toBe(true);
    expect(await out(work, ['rev-parse', 'main'])).toBe(originHead); // ff'd to origin's tip
    expect(await out(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('other'); // never checked out main
  });

  it('refuses to update a branch with no remote-tracking upstream', async () => {
    const { work } = await setupBehindClone(); // currently on 'other', which has no upstream
    const h = makeHandlers(work);
    const r = await h.updateBranch({ projectId: 1, branch: 'other' }, {} as never);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/upstream/i);
  });
});
