/**
 * End-to-end engine tests for the conflict resolver — drive a REAL git
 * cherry-pick conflict in a temp repo (no DB / no Electron). The deps are
 * the same shape index.ts injects: thin spawn wrappers for runGit /
 * runAsResult plus a fake requireRoot/detectRepo pointing at the temp repo.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

function makeHandlers(dir: string) {
  return createConflictHandlers({
    runGit,
    runAsResult,
    requireRoot: () => dir,
    detectRepo: async (root) => {
      const r = await runGit(root, ['rev-parse', '--show-toplevel']);
      return r.code === 0 ? { repoRoot: r.stdout.trim(), notARepo: false } : { repoRoot: null, notARepo: true };
    },
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
    expect(s.oursLabel).toBe('main');
    expect(s.theirsLabel).toBe('feature change');
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
  }, 20_000);

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
