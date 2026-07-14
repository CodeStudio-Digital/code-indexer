/**
 * Tests for the opt-in git performance accelerators. untrackedCache is driven
 * against REAL git in a temp repo (no daemon side-effect); the fsmonitor
 * version-guard is tested with a FAKE runGit so we exercise BOTH the
 * supported and unsupported branches deterministically on any machine —
 * WITHOUT ever spawning the long-lived fsmonitor daemon.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitOptimizationHandlers } from '../git-optimizations.js';

interface GitResult { code: number; stdout: string; stderr: string; }

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: (e as Error).message }));
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
  });
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

async function setupRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gitopt-'));
  dirs.push(dir);
  const g = async (...args: string[]) => {
    const r = await runGit(dir, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
  };
  await g('init', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'Tester');
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  await g('add', '.');
  await g('commit', '-m', 'base');
  return dir;
}

/** A runGit stub that reports a fixed git version and records every invocation. */
function fakeGit(version: string, calls: string[][]): typeof runGit {
  return (_cwd, args) => {
    calls.push(args);
    if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: `git version ${version}`, stderr: '' });
    // No config is "set" in the fake unless we wrote it this run.
    if (args[0] === 'config' && args.includes('--get')) {
      const key = args[args.length - 1];
      const wrote = calls.some((a) => a[0] === 'config' && a[1] === key && a[2] === 'true');
      return Promise.resolve(wrote ? { code: 0, stdout: 'true', stderr: '' } : { code: 1, stdout: '', stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

describe('git optimizations', () => {
  it('reads defaults off and toggles untrackedCache on/off reversibly (real git)', async () => {
    const dir = await setupRepo();
    const h = createGitOptimizationHandlers({ runGit, resolveCwd: async () => dir });

    const before = await h.gitOptimizations({ projectId: 1 }, {} as never);
    expect(before.untrackedCache).toBe(false);
    expect(before.fsmonitor).toBe(false);
    expect(before.gitVersion).toMatch(/^\d+\.\d+/);

    const on = await h.configureGitOptimizations({ projectId: 1, untrackedCache: true }, {} as never);
    expect(on.untrackedCache).toBe(true);
    expect((await runGit(dir, ['config', '--get', 'core.untrackedCache'])).stdout.trim()).toBe('true');

    const off = await h.configureGitOptimizations({ projectId: 1, untrackedCache: false }, {} as never);
    expect(off.untrackedCache).toBe(false);
    // Disable fully unsets (reversible) — --get now exits non-zero.
    expect((await runGit(dir, ['config', '--get', 'core.untrackedCache'])).code).not.toBe(0);
  });

  it('REFUSES core.fsmonitor on git < 2.37 (would break status); no config write, no daemon', async () => {
    const calls: string[][] = [];
    const h = createGitOptimizationHandlers({ runGit: fakeGit('2.20.1', calls), resolveCwd: async () => '/x' });
    await expect(
      h.configureGitOptimizations({ projectId: 1, fsmonitor: true }, {} as never),
    ).rejects.toMatchObject({ code: 'git_fsmonitor_unsupported', status: 412 });
    expect(calls.some((a) => a[0] === 'config' && a[1] === 'core.fsmonitor' && a[2] === 'true')).toBe(false);
    expect(calls.some((a) => a[0] === 'fsmonitor--daemon' && a[1] === 'start')).toBe(false);
  });

  it('enables core.fsmonitor + starts the daemon on git ≥ 2.37', async () => {
    const calls: string[][] = [];
    const h = createGitOptimizationHandlers({ runGit: fakeGit('2.45.1', calls), resolveCwd: async () => '/x' });
    const res = await h.configureGitOptimizations({ projectId: 1, fsmonitor: true }, {} as never);
    expect(res.fsmonitorSupported).toBe(true);
    expect(res.fsmonitor).toBe(true);
    expect(calls.some((a) => a[0] === 'config' && a[1] === 'core.fsmonitor' && a[2] === 'true')).toBe(true);
    expect(calls.some((a) => a[0] === 'fsmonitor--daemon' && a[1] === 'start')).toBe(true);
  });
});
