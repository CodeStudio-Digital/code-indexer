/**
 * GitMetaWatcher: deterministic HEAD/gitdir parsing via readCurrent (no timing)
 * plus one live test that a HEAD rewrite (branch switch) fires onChange. Uses a
 * real temp dir with a fake `.git`; no git binary, no native ABI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitMetaWatcher, ownerGitDir, isWatchIgnored, type GitMetaEvent } from '../git-meta-watcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRepo(headContent: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gmw-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), headContent);
  return root;
}

const watcher = new GitMetaWatcher();
const roots: string[] = [];
afterEach(async () => {
  await watcher.stopAll();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('multi-root ignore predicate (cross-platform separator contract)', () => {
  // chokidar v4 hands `ignored` FORWARD-slash paths; the gitdirs are native
  // (backslash on Windows). The predicate must work across that mismatch — else
  // pruning silently never fires on Windows and the whole object DB gets watched.
  const main = 'D:\\proj\\.git';
  const sub = 'D:\\proj\\.git\\modules\\foo';
  const dirs = [main, sub];

  it('owner is the DEEPEST gitdir (submodule, not the enclosing main)', () => {
    expect(ownerGitDir(dirs, 'D:/proj/.git/modules/foo/HEAD')).toBe(sub);
    expect(ownerGitDir(dirs, 'D:/proj/.git/HEAD')).toBe(main);
  });

  it('prunes object DB / logs / fsmonitor of BOTH main and submodule', () => {
    expect(isWatchIgnored(dirs, 'D:/proj/.git/objects/ab/cd')).toBe(true);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/logs/HEAD')).toBe(true);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/fsmonitor--daemon/sock')).toBe(true);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/modules/foo/objects/ab/cd')).toBe(true);
    // The main watch must not descend into the modules tree (the submodule gitdir
    // is watched as its OWN explicit root instead).
    expect(isWatchIgnored(dirs, 'D:/proj/.git/modules')).toBe(true);
  });

  it('watches HEAD/refs/sequencer of BOTH main and submodule', () => {
    expect(isWatchIgnored(dirs, 'D:/proj/.git/HEAD')).toBe(false);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/refs/heads/main')).toBe(false);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/MERGE_HEAD')).toBe(false);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/modules/foo/HEAD')).toBe(false);
    expect(isWatchIgnored(dirs, 'D:/proj/.git/modules/foo/refs/heads/x')).toBe(false);
  });
});

describe('readCurrent', () => {
  it('parses a branch ref', () => {
    const root = makeRepo('ref: refs/heads/feature/x\n');
    roots.push(root);
    expect(watcher.readCurrent(root)).toEqual({ branch: 'feature/x', detached: false, changed: [] });
  });

  it('flags a detached HEAD (raw sha)', () => {
    const root = makeRepo('0123456789abcdef0123456789abcdef01234567\n');
    roots.push(root);
    expect(watcher.readCurrent(root)).toEqual({ branch: null, detached: true, changed: [] });
  });

  it('returns null when the project is not a git repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'gmw-norepo-'));
    roots.push(root);
    expect(watcher.readCurrent(root)).toBeNull();
  });

  it('resolves a worktree `.git` file pointing at the real gitdir', () => {
    const root = mkdtempSync(join(tmpdir(), 'gmw-wt-'));
    roots.push(root);
    const realGitDir = join(root, 'realgit');
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git'), `gitdir: ${realGitDir}\n`);
    expect(watcher.readCurrent(root)).toEqual({ branch: 'main', detached: false, changed: [] });
  });
});

describe('live watch', () => {
  it('fires onChange with the new branch when HEAD is rewritten', async () => {
    const root = makeRepo('ref: refs/heads/main\n');
    roots.push(root);

    let resolveEvent: (e: GitMetaEvent) => void;
    const got = new Promise<GitMetaEvent>((resolve) => { resolveEvent = resolve; });
    watcher.startWatching(1, root, { onChange: (e) => resolveEvent(e) });

    // Let chokidar finish its initial scan before mutating (ignoreInitial).
    await sleep(600);
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/develop\n');

    const event = await Promise.race([
      got,
      sleep(4000).then(() => null),
    ]);
    expect(event).not.toBeNull();
    expect(event!.changed).toContain('head');
    expect(event!.branch).toBe('develop');
  }, 8000);

  it('prunes objects/ and logs/ (no event/descent) but still sees HEAD', async () => {
    const root = makeRepo('ref: refs/heads/main\n');
    roots.push(root);
    mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
    mkdirSync(join(root, '.git', 'logs'), { recursive: true });

    const events: GitMetaEvent[] = [];
    watcher.startWatching(2, root, { onChange: (e) => { events.push(e); } });
    await sleep(600);

    // Churn inside ignored subtrees — the object DB + reflog must be silent.
    writeFileSync(join(root, '.git', 'objects', 'ab', 'deadbeef'), 'x');
    writeFileSync(join(root, '.git', 'logs', 'HEAD'), 'reflog line\n');
    await sleep(1000);
    expect(events).toHaveLength(0);

    // Sanity: a real HEAD change still fires through the same watcher.
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
    await sleep(1200);
    expect(events.some((e) => e.changed.includes('head') && e.branch === 'dev')).toBe(true);
  }, 8000);

  it('masks a transient unreadable HEAD instead of emitting a false detached', async () => {
    const root = makeRepo('ref: refs/heads/main\n');
    roots.push(root);
    const events: GitMetaEvent[] = [];
    watcher.startWatching(3, root, { onChange: (e) => { events.push(e); } });
    await sleep(600);

    // Empty HEAD (mid-write) — readHead can't parse it; the watcher should keep
    // the last known branch ('main'), not publish branch:null/detached:false.
    writeFileSync(join(root, '.git', 'HEAD'), '');
    await sleep(1000);
    if (events.length > 0) {
      const last = events[events.length - 1];
      expect(last.branch).toBe('main');
      expect(last.detached).toBe(false);
    }
  }, 8000);
});
