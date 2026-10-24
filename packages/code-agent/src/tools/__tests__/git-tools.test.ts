/**
 * git_status / git_log — 334 historical git_status calls, zero tests. Real
 * `git` binary against a temp repo (no mocks: the contract under test is the
 * exit-code → ok/err mapping and the "(no output)" empty-tree shape).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { gitTools, withManagedCommitAttribution } from '../git.js';

const gitStatus = gitTools.find((t) => t.name === 'git_status')!;
const gitLog = gitTools.find((t) => t.name === 'git_log')!;

let repo: string;
let bare: string;

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-tools-repo-'));
  bare = mkdtempSync(join(tmpdir(), 'git-tools-bare-'));
  git(['init'], repo);
  git(['config', 'user.email', 'test@codestudio.local'], repo);
  git(['config', 'user.name', 'CodeStudio Tests'], repo);
  writeFileSync(join(repo, 'committed.txt'), 'v1');
  git(['add', '.'], repo);
  git(['commit', '-m', 'initial commit'], repo);
});
afterAll(() => {
  for (const [target, prefix] of [[repo, 'git-tools-repo-'], [bare, 'git-tools-bare-']] as const) {
    if (!target) continue;
    if (dirname(resolve(target)) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) {
      throw new Error('Refusing to remove a path outside the owned Git test fixture');
    }
    // Git loose objects are read-only on Windows. Electron's native recursive
    // rm can return EPERM without clearing that bit, even after all Git children
    // exit. Only touch regular files inside this verified, freshly owned fixture;
    // never follow links or change permissions in the developer's repository.
    if (process.platform === 'win32') {
      const clearReadOnly = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const child = join(directory, name), stat = lstatSync(child);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) clearReadOnly(child);
          else if (stat.isFile()) chmodSync(child, 0o600);
        }
      };
      clearReadOnly(target);
    }
    // Git/antivirus handles may linger briefly after a Windows child exits.
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const ctxFor = (cwd: string): ToolContext => ({ cwd, projectName: 'git-tools-test' }) as ToolContext;

describe('git_status', () => {
  it('reports "(no output)" on a clean tree (short format is empty)', async () => {
    const res = await gitStatus.handler({}, ctxFor(repo));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('(no output)');
  });

  it('lists untracked files in short format', async () => {
    writeFileSync(join(repo, 'new-file.ts'), 'x');
    try {
      const res = await gitStatus.handler({}, ctxFor(repo));
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain('?? new-file.ts');
    } finally {
      rmSync(join(repo, 'new-file.ts'), { force: true });
    }
  });

  it('outside a repo → isError with the git exit code surfaced', async () => {
    const res = await gitStatus.handler({}, ctxFor(bare));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('git status --short exited 128');
  });
});

describe('git_log', () => {
  it('returns the oneline history', async () => {
    const res = await gitLog.handler({ limit: 5 }, ctxFor(repo));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('initial commit');
  });
});

describe('managed commit attribution', () => {
  it('adds the verified GitHub bot noreply identity when managed attribution is enabled', () => {
    expect(withManagedCommitAttribution('feat: agent change', {
      MEGABRAIN_GIT_IDENTITY_DEFAULT: 'managed',
      MEGABRAIN_GIT_PUBLIC_ATTRIBUTION: '1',
    })).toBe(
      'feat: agent change\n\n' +
      'Co-authored-by: MegaBrainStudio <306376051+megabrainstudio[bot]@users.noreply.github.com>',
    );
  });

  it('keeps the user commit untouched when project identity or private attribution is selected', () => {
    expect(withManagedCommitAttribution('fix: local', {
      MEGABRAIN_GIT_IDENTITY_DEFAULT: 'project',
      MEGABRAIN_GIT_PUBLIC_ATTRIBUTION: '1',
    })).toBe('fix: local');
    expect(withManagedCommitAttribution('fix: private', {
      MEGABRAIN_GIT_IDENTITY_DEFAULT: 'managed',
      MEGABRAIN_GIT_PUBLIC_ATTRIBUTION: '0',
    })).toBe('fix: private');
  });

  it('does not duplicate an existing MegaBrain co-author trailer', () => {
    const attributed = withManagedCommitAttribution('docs: explain', {
      MEGABRAIN_GIT_IDENTITY_DEFAULT: 'managed',
      MEGABRAIN_GIT_PUBLIC_ATTRIBUTION: '1',
    });
    expect(withManagedCommitAttribution(attributed, {
      MEGABRAIN_GIT_IDENTITY_DEFAULT: 'managed',
      MEGABRAIN_GIT_PUBLIC_ATTRIBUTION: '1',
    })).toBe(attributed);
  });
});
