/**
 * End-to-end engine tests for the conflict resolver — drive a REAL git
 * cherry-pick conflict in a temp repo (no DB / no Electron). The deps are
 * the same shape index.ts injects: thin spawn wrappers for runGit /
 * runAsResult plus a fake requireRoot/detectRepo pointing at the temp repo.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

// These are REAL-git integration tests: each test spawns ~10-20 `git`
// processes against a fresh temp repo. On Windows (esp. with Defender
// scanning %TEMP%) a spawn can cost ~0.5s, so the default 5s/20s timeouts
// are far too tight. Give them generous headroom.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConflictHandlers } from '../conflicts.js';

interface GitResult { code: number; stdout: string; stderr: string; }

function runGit(
  cwd: string,
  args: string[],
  optsOrStdin?: string | { stdin?: string; env?: Record<string, string> },
): Promise<GitResult> {
  const opts = typeof optsOrStdin === 'string' ? { stdin: optsOrStdin } : (optsOrStdin ?? {});
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: (e as Error).message }));
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    if (opts.stdin) { child.stdin.write(opts.stdin); child.stdin.end(); } else { child.stdin.end(); }
  });
}

function runAsResult(cwd: string, _cmd: 'git', args: string[], env?: Record<string, string>) {
  return runGit(cwd, args, env ? { env } : undefined).then((r) => ({
    command: 'git', args, ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr,
  }));
}

// Mirror index.ts detectRepo: one spawn yields repoRoot + the resolved
// absolute gitDir, which lets detectMergeKind read sequencer state via pure fs.
async function fakeDetectRepo(root: string) {
  const r = await runGit(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (r.code !== 0) return { repoRoot: null, gitDir: null, notARepo: true };
  const [repoRoot = '', gitDir = ''] = r.stdout.split('\n').map((s) => s.trim());
  return { repoRoot, gitDir, notARepo: false };
}

function makeHandlers(dir: string) {
  return createConflictHandlers({
    runGit,
    runAsResult,
    resolveCwd: async () => dir,
    detectRepo: fakeDetectRepo,
    resolveRepoForPath: async (_id: number, p: string) => ({ cwd: dir, repoRelPath: p }),
  });
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

/** Build a fresh repo already parked in a cherry-pick conflict on file.txt. */
async function setupConflictRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-conflict-'));
  dirs.push(dir);
  const g = async (...args: string[]) => {
    const r = await runGit(dir, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
    return r;
  };
  await g('init', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'Tester');
  await g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'a\nshared\nz\n');
  await g('add', '.');
  await g('commit', '-m', 'base');
  await g('checkout', '-b', 'feature');
  writeFileSync(join(dir, 'file.txt'), 'a\nFEATURE\nz\n');
  await g('commit', '-am', 'feature change');
  const sha = (await g('rev-parse', 'HEAD')).stdout.trim();
  await g('checkout', 'main');
  writeFileSync(join(dir, 'file.txt'), 'a\nMAIN\nz\n');
  await g('commit', '-am', 'main change');
  // Expected to fail with a conflict — that's the state under test.
  await runGit(dir, ['cherry-pick', sha]);
  return dir;
}

describe('conflict resolver engine', () => {
  it('detects an in-progress cherry-pick and its conflicted files', async () => {
    const h = makeHandlers(await setupConflictRepo());
    const s = await h.mergeState({ projectId: 1 }, {} as never);
    expect(s.kind).toBe('cherry-pick');
    expect(s.conflictedFiles).toContain('file.txt');
    // One path per conflicted file (no per-stage duplication from the index).
    expect(s.conflictedFiles).toHaveLength(1);
    expect(s.oursLabel).toBe('main'); // derived from fs HEAD read, not `branch --show-current`
    expect(s.theirsLabel).toBe('feature change');
  });

  // Regression for the perf overhaul: with a resolved gitDir, sequencer
  // detection must be PURE fs — zero `rev-parse --git-path` spawns (the old
  // 5-6 spawn cascade was the 63s bottleneck on heavy repos).
  it('detects sequencer state with no rev-parse --git-path spawns when gitDir is known', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-clean-'));
    dirs.push(dir);
    const g = async (...args: string[]) => {
      const r = await runGit(dir, args);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
    };
    await g('init', '-b', 'main');
    await g('config', 'user.email', 't@example.com');
    await g('config', 'user.name', 'Tester');
    await g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'file.txt'), 'hello\n');
    await g('add', '.');
    await g('commit', '-m', 'base');

    let gitPathSpawns = 0;
    const spyRunGit: typeof runGit = (cwd, args, opts) => {
      if (args[0] === 'rev-parse' && args.includes('--git-path')) gitPathSpawns++;
      return runGit(cwd, args, opts);
    };
    const h = createConflictHandlers({
      runGit: spyRunGit,
      runAsResult,
      resolveCwd: async () => dir,
      detectRepo: fakeDetectRepo,
      resolveRepoForPath: async (_id: number, p: string) => ({ cwd: dir, repoRelPath: p }),
    });
    const s = await h.mergeState({ projectId: 1 }, {} as never);
    expect(s.kind).toBeNull(); // clean repo, no op in progress
    expect(gitPathSpawns).toBe(0); // pure-fs path, not the spawn cascade
  });

  it('reads ours/theirs/merged for a conflicted file', async () => {
    const h = makeHandlers(await setupConflictRepo());
    const cf = await h.conflictFile({ projectId: 1, path: 'file.txt' }, {} as never);
    expect(cf.binary).toBe(false);
    expect(cf.hasOurs).toBe(true);
    expect(cf.hasTheirs).toBe(true);
    expect(cf.ours).toContain('MAIN');
    expect(cf.theirs).toContain('FEATURE');
    expect(cf.merged).toContain('<<<<<<<');
  });

  it('resolves by taking ours and stages it (no conflicts remain)', async () => {
    const dir = await setupConflictRepo();
    const h = makeHandlers(dir);
    await h.resolveConflict({ projectId: 1, path: 'file.txt', resolution: 'ours' }, {} as never);
    const s = await h.mergeState({ projectId: 1 }, {} as never);
    expect(s.conflictedFiles).toHaveLength(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toContain('MAIN');
  });

  it('writes explicit merged content and stages it', async () => {
    const dir = await setupConflictRepo();
    const h = makeHandlers(dir);
    await h.resolveConflict(
      { projectId: 1, path: 'file.txt', resolution: { content: 'a\nMERGED\nz\n' } },
      {} as never,
    );
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('a\nMERGED\nz\n');
    const s = await h.mergeState({ projectId: 1 }, {} as never);
    expect(s.conflictedFiles).toHaveLength(0);
  });

  it('refuses to continue while conflicts remain', async () => {
    const h = makeHandlers(await setupConflictRepo());
    await expect(h.mergeContinue({ projectId: 1 }, {} as never)).rejects.toThrow(/unresolved/i);
  });

  it('continues the cherry-pick non-interactively once resolved', async () => {
    const dir = await setupConflictRepo();
    const h = makeHandlers(dir);
    // Take 'theirs' so the pick produces a real change — resolving with our
    // own side here would make the cherry-pick empty (ours === HEAD) and git
    // would (correctly) refuse with a "now empty" message.
    await h.resolveConflict({ projectId: 1, path: 'file.txt', resolution: 'theirs' }, {} as never);
    const r = await h.mergeContinue({ projectId: 1 }, {} as never);
    expect(r.ok).toBe(true);
    const after = await h.mergeState({ projectId: 1 }, {} as never);
    expect(after.kind).toBeNull();
  });

  it('aborts an in-progress cherry-pick', async () => {
    const dir = await setupConflictRepo();
    const h = makeHandlers(dir);
    const r = await h.mergeAbort({ projectId: 1 }, {} as never);
    expect(r.ok).toBe(true);
    const after = await h.mergeState({ projectId: 1 }, {} as never);
    expect(after.kind).toBeNull();
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toContain('MAIN');
  });
});

/** Build a repo parked in a `git stash pop` conflict (no sequencer state). */
async function setupStashConflictRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-stash-'));
  dirs.push(dir);
  const g = async (...args: string[]) => {
    const r = await runGit(dir, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
    return r;
  };
  await g('init', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'Tester');
  await g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'a\nshared\nz\n');
  await g('add', '.');
  await g('commit', '-m', 'base');
  writeFileSync(join(dir, 'file.txt'), 'a\nSTASHED\nz\n');
  await g('stash', 'push', '-m', 'wip'); // working tree reverts to 'shared'
  writeFileSync(join(dir, 'file.txt'), 'a\nCOMMITTED\nz\n');
  await g('commit', '-am', 'committed change');
  await runGit(dir, ['stash', 'pop']); // conflicts on the shared line
  return dir;
}

describe('conflict resolver — stash / working-tree mode', () => {
  it("reports kind 'working-tree' for a stash-pop conflict (no sequencer op)", async () => {
    const h = makeHandlers(await setupStashConflictRepo());
    const s = await h.mergeState({ projectId: 1 }, {} as never);
    expect(s.kind).toBe('working-tree');
    expect(s.conflictedFiles).toContain('file.txt');
    expect(s.theirsLabel).toBe(''); // no incoming commit
  });

  it('discards via mergeAbort (checkout HEAD) while the stash entry survives', async () => {
    const dir = await setupStashConflictRepo();
    const h = makeHandlers(dir);
    const r = await h.mergeAbort({ projectId: 1 }, {} as never);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toContain('COMMITTED'); // restored to HEAD
    const after = await h.mergeState({ projectId: 1 }, {} as never);
    expect(after.kind).toBeNull();
    // The stash was NOT dropped on the conflicting pop — still recoverable.
    const stashes = (await runGit(dir, ['stash', 'list'])).stdout.trim();
    expect(stashes).not.toBe('');
  });

  // Regression for the atomic-abort bug: a modify/delete stash conflict leaves
  // the conflicted path ABSENT from HEAD, so a single `git checkout HEAD -- <f>`
  // would fail the whole batch. Abort must `git rm` such paths instead.
  it('aborts a modify/delete stash conflict (path absent from HEAD) without failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-md-'));
    dirs.push(dir);
    const g = async (...args: string[]) => {
      const r = await runGit(dir, args);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
      return r;
    };
    await g('init', '-b', 'main');
    await g('config', 'user.email', 't@example.com');
    await g('config', 'user.name', 'Tester');
    await g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'target.txt'), 'original\n');
    await g('add', '.');
    await g('commit', '-m', 'base');
    writeFileSync(join(dir, 'target.txt'), 'STASHED MOD\n');
    await g('stash', 'push', '-m', 'wip'); // working tree back to 'original'
    await g('rm', 'target.txt');
    await g('commit', '-m', 'delete target'); // HEAD no longer has target.txt
    await runGit(dir, ['stash', 'pop']); // modify/delete conflict on target.txt

    const h = makeHandlers(dir);
    const before = await h.mergeState({ projectId: 1 }, {} as never);
    expect(before.kind).toBe('working-tree');
    expect(before.conflictedFiles).toContain('target.txt');
    // Sanity: the path really is absent from HEAD (the atomic-batch trap).
    expect((await runGit(dir, ['cat-file', '-e', 'HEAD:target.txt'])).code).not.toBe(0);

    const r = await h.mergeAbort({ projectId: 1 }, {} as never);
    expect(r.ok).toBe(true); // would be false with the old single-batch checkout
    expect(existsSync(join(dir, 'target.txt'))).toBe(false); // restored to HEAD (deleted)
    const after = await h.mergeState({ projectId: 1 }, {} as never);
    expect(after.kind).toBeNull();
  });
});
