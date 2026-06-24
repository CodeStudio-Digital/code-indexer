import { describe, expect, it } from 'vitest';
import {
  githubUrlFor,
  repoRelativePosix,
  toNativeAbsolute,
  toRepoRelative,
} from '../path-ref.js';

describe('toNativeAbsolute', () => {
  it('joins a Windows root with backslashes and converts the posix rel', () => {
    expect(toNativeAbsolute('D:\\poa-monorepo\\backend', 'src/deploy.sh')).toBe(
      'D:\\poa-monorepo\\backend\\src\\deploy.sh',
    );
  });

  it('joins a POSIX root with slashes', () => {
    expect(toNativeAbsolute('/home/me/app', 'src/a.ts')).toBe('/home/me/app/src/a.ts');
  });

  it('strips trailing separators on the root and leading on the rel', () => {
    expect(toNativeAbsolute('D:\\repo\\', '/a/b.ts')).toBe('D:\\repo\\a\\b.ts');
  });

  it('returns the root for an empty rel', () => {
    expect(toNativeAbsolute('/home/me/app', '')).toBe('/home/me/app');
  });
});

describe('repoRelativePosix / toRepoRelative', () => {
  it('returns null when project IS the repo root', () => {
    expect(repoRelativePosix('D:/repo/app', 'D:\\repo\\app', 'src/a.ts')).toBeNull();
    expect(toRepoRelative('D:/repo/app', 'D:\\repo\\app', 'src/a.ts')).toBeNull();
  });

  it('computes the prefix when the project is nested under the repo (Windows, git-style repoRoot)', () => {
    // git reports `D:/poa-monorepo`; root_path is native `D:\poa-monorepo\backend`.
    expect(repoRelativePosix('D:/poa-monorepo', 'D:\\poa-monorepo\\backend', 'deploy.sh')).toBe(
      'backend/deploy.sh',
    );
    expect(toRepoRelative('D:/poa-monorepo', 'D:\\poa-monorepo\\backend', 'deploy.sh')).toBe(
      'backend\\deploy.sh',
    );
  });

  it('is case-insensitive on Windows drive/letters', () => {
    expect(repoRelativePosix('d:/Repo', 'D:\\repo\\app', 'a.ts')).toBe('app/a.ts');
  });

  it('computes the prefix on POSIX', () => {
    expect(toRepoRelative('/home/me/mono', '/home/me/mono/pkg', 'src/a.ts')).toBe('pkg/src/a.ts');
  });

  it('returns null when repoRoot is null', () => {
    expect(toRepoRelative(null, '/home/me/app', 'a.ts')).toBeNull();
  });

  it('returns null when the file is not under the repo root (defensive)', () => {
    expect(repoRelativePosix('/other/repo', '/home/me/app', 'a.ts')).toBeNull();
  });
});

describe('githubUrlFor', () => {
  const rel = 'src/index.ts';

  it('normalises an ssh-scp remote', () => {
    expect(githubUrlFor('git@github.com:org/repo.git', 'main', rel)).toBe(
      'https://github.com/org/repo/blob/main/src/index.ts',
    );
  });

  it('normalises an https remote without .git', () => {
    expect(githubUrlFor('https://github.com/org/repo', 'develop', rel)).toBe(
      'https://github.com/org/repo/blob/develop/src/index.ts',
    );
  });

  it('normalises an ssh:// remote', () => {
    expect(githubUrlFor('ssh://git@github.com/org/repo.git', 'main', rel)).toBe(
      'https://github.com/org/repo/blob/main/src/index.ts',
    );
  });

  it('falls back to HEAD when no branch', () => {
    expect(githubUrlFor('git@github.com:org/repo.git', null, rel)).toBe(
      'https://github.com/org/repo/blob/HEAD/src/index.ts',
    );
  });

  it('returns null for a non-GitHub remote', () => {
    expect(githubUrlFor('git@gitlab.com:org/repo.git', 'main', rel)).toBeNull();
    expect(githubUrlFor('', 'main', rel)).toBeNull();
  });
});
