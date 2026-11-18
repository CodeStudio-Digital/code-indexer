/**
 * GitMetaWatcher: deterministic HEAD/gitdir parsing via readCurrent (no timing)
 * plus one live test that a HEAD rewrite (branch switch) fires onChange. Uses a
 * real temp dir with a fake `.git`; no git binary, no native ABI.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  it('parses a branch ref', async () => {
    const root = makeRepo('ref: refs/heads/feature/x\n');
    roots.push(root);
    expect(await watcher.readCurrent(root)).toEqual({ branch: 'feature/x', detached: false, changed: [] });
  });

  it('flags a detached HEAD (raw sha)', async () => {
    const root = makeRepo('0123456789abcdef0123456789abcdef01234567\n');
    roots.push(root);
    expect(await watcher.readCurrent(root)).toEqual({ branch: null, detached: true, changed: [] });
  });

  it('returns null when the project is not a git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gmw-norepo-'));
    roots.push(root);
    expect(await watcher.readCurrent(root)).toBeNull();
  });

  it('resolves a worktree `.git` file pointing at the real gitdir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gmw-wt-'));
    roots.push(root);
    const realGitDir = join(root, 'realgit');
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git'), `gitdir: ${realGitDir}\n`);
    expect(await watcher.readCurrent(root)).toEqual({ branch: 'main', detached: false, changed: [] });
  });

  it('resolves the enclosing repository when the project is a nested directory', async () => {
    const root = makeRepo('ref: refs/heads/parent-main\n');
    roots.push(root);
    const project = join(root, 'packages', 'app');
    mkdirSync(project, { recursive: true });
    expect(await watcher.readCurrent(project)).toEqual({ branch: 'parent-main', detached: false, changed: [] });
  });
});

describe('live watch', () => {
  it('delivers HEAD changes during slow sibling discovery and drops a retired subscription', async () => {
    const root = makeRepo('ref: refs/heads/main\n');
    const replacement = makeRepo('ref: refs/heads/other\n');
    roots.push(root, replacement);
    const sibling = join(root, 'sibling');
    mkdirSync(sibling);
    const events: GitMetaEvent[] = [];
    const next: GitMetaEvent[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(done => { release = done; });
    let visited!: () => void;
    const entered = new Promise<void>(done => { visited = done; });
    const original = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === sibling) { visited(); await blocked; }
      return original(...args);
    }) as typeof fs.readdir);
    try {
      watcher.startWatching(4, root, { onChange: e => { events.push(e); } });
      await entered;
      await sleep(150);
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/first\n');
      await vi.waitFor(() => expect(events.at(-1)?.branch).toBe('first'), { timeout: 5_000 });
      await watcher.stopWatching(4);
      watcher.startWatching(4, replacement, { onChange: e => { next.push(e); } });
      release();
      await sleep(200);
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/retired\n');
      writeFileSync(join(replacement, '.git', 'HEAD'), 'ref: refs/heads/second\n');
      await vi.waitFor(() => expect(next.at(-1)?.branch).toBe('second'), { timeout: 5_000 });
      expect(events.map(e => e.branch)).toEqual(['first']);
    } finally { release(); spy.mockRestore(); }
  });

  it('watches the selected linked HEAD and common refs without observing sibling checkouts', async () => {
    const root = makeRepo('ref: refs/heads/main\n');
    const linked = mkdtempSync(join(tmpdir(), 'gmw-linked-'));
    roots.push(root, linked);
    const common = join(root, '.git');
    const gitDir = join(common, 'worktrees', 'selected');
    const other = join(common, 'worktrees', 'other');
    for (const dir of [gitDir, other, join(common, 'refs', 'heads')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/topic\n');
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    const events: GitMetaEvent[] = [];
    watcher.startWatching(5, linked, { onChange: e => { events.push(e); } });
    await sleep(450);
    writeFileSync(join(other, 'HEAD'), 'ref: refs/heads/sibling\n');
    writeFileSync(join(common, 'HEAD'), 'ref: refs/heads/main-switched\n');
    writeFileSync(join(common, 'refs', 'heads', 'topic'), 'a'.repeat(40) + '\n');
    await vi.waitFor(() => expect(events.some(e => e.branch === 'topic' && e.changed.includes('ref'))).toBe(true), { timeout: 5_000 });
    expect(events.flatMap(e => e.changed)).not.toContain('head');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/renamed\n');
    await vi.waitFor(() => expect(events.at(-1)?.branch).toBe('renamed'), { timeout: 5_000 });
  });

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
