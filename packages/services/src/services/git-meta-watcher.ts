import { watch, type FSWatcher } from 'chokidar';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Watches a project's `.git` metadata (HEAD + refs + sequencer state) so the
 * app can react to branch switches — whether triggered in-app or by an
 * external `git checkout` in a terminal. The working-tree watcher
 * (FileWatcherService) deliberately ignores `.git/**`; this is its sibling for
 * the git-identity signal it can't see.
 *
 * Only the cheap/relevant entries are watched: `objects/`, `logs/`, `index`
 * and lock files are noise and are ignored so we never descend the object DB.
 */

export type GitMetaChange = 'head' | 'ref' | 'sequencer';

export interface GitMetaEvent {
  /** Current branch name, or null when detached / unreadable. */
  branch: string | null;
  detached: boolean;
  /** Distinct kinds of git-dir change seen in this debounced batch. */
  changed: GitMetaChange[];
}

export interface GitMetaWatcherEvents {
  onChange(event: GitMetaEvent): void | Promise<void>;
}

/** `<root>/.git` is usually a dir; for worktrees/submodules it's a file
 *  pointing at the real gitdir (`gitdir: …`). Returns null when there's no repo.
 *  Linked worktrees have their own HEAD and share the refs in commondir. */
async function resolveDotGit(rootPath: string): Promise<string | null> {
  const dotGit = join(rootPath, '.git');
  let st;
  try {
    st = await fs.stat(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    try {
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
      return m ? resolve(rootPath, m[1].trim()) : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveGitContext(rootPath: string): Promise<{ repoRoot: string; gitDir: string } | null> {
  let current = resolve(rootPath);
  while (true) {
    const gitDir = await resolveDotGit(current);
    if (gitDir) return { repoRoot: current, gitDir };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolveCommonGitDir(gitDir: string): Promise<string | null> {
  try {
    const rel = (await fs.readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    return rel ? resolve(gitDir, rel) : null;
  } catch {
    return null;
  }
}

const NESTED_DENY = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', 'vendor', 'target', '.mcp-indexer', '.tmp', 'Library', 'Temp', 'obj']);

async function resolveNestedGitDirs(projectRoot: string, active: () => boolean): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];
  for (let cursor = 0; cursor < queue.length && active();) {
    const batch = queue.slice(cursor, cursor + 8);
    cursor += batch.length;
    const listings = await Promise.all(batch.map(({ dir }) => fs.readdir(dir, { withFileTypes: true }).catch(() => [])));
    for (const [i, { dir, depth }] of batch.entries()) {
      if (!active()) return [];
      const entries = listings[i]!;
      if (dir !== projectRoot && entries.some(entry => entry.name === '.git')) {
        const gitDir = await resolveDotGit(dir);
        if (gitDir) out.push(gitDir);
        continue;
      }
      if (depth >= 3) continue;
      for (const entry of entries) {
        if (queue.length >= 1_000) break;
        if (entry.isDirectory() && !NESTED_DENY.has(entry.name)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return out;
}

/** Resolve the gitdirs of a repo's INITIALIZED submodules by parsing
 *  `.gitmodules` for their paths and following each one's `.git` file (which
 *  points into `<main>/.git/modules/<name>`). Pure fs — no git spawn. Lets the
 *  watcher catch a branch switch / commit INSIDE a submodule, which the parent's
 *  gitdir never reflects (its `.git/modules/**` is high-churn noise we prune). */
async function resolveSubmoduleGitDirs(rootPath: string, active: () => boolean): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(join(rootPath, '.gitmodules'), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  const re = /^\s*path\s*=\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while (active() && (m = re.exec(text)) !== null) {
    const sub = m[1].trim();
    if (!sub) continue;
    const gd = await resolveDotGit(join(rootPath, sub));
    if (gd) out.push(gd);
  }
  return out;
}

/** Is `child` the same as, or nested under, `parent`? Separator-agnostic: chokidar
 *  v4 hands the `ignored` predicate FORWARD-slash paths while our gitdirs are
 *  native (backslash on Windows), so we normalize both before comparing — else
 *  pruning silently never fires on Windows and we'd watch the whole object DB. */
function isUnderOrEq(parent: string, child: string): boolean {
  const p = parent.replace(/\\/g, '/');
  const c = child.replace(/\\/g, '/');
  return c === p || c.startsWith(p + '/');
}

/** `.git/HEAD` → branch name, or detached when it holds a raw commit sha. The
 *  ambiguous {branch:null, detached:false} return means "couldn't determine"
 *  (unreadable mid-write / empty) — startWatching falls back to the last known
 *  state for that case so a transient read never emits a false "detached". */
async function readHead(gitDir: string): Promise<{ branch: string | null; detached: boolean }> {
  try {
    const head = (await fs.readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return { branch: ref[1].trim(), detached: false };
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: null, detached: true };
  } catch {
    /* unreadable mid-write — fall back to the last known branch */
  }
  return { branch: null, detached: false };
}

/** gitDir-relative POSIX path of an absolute chokidar path. */
function relInGitDir(absPath: string, gitDir: string): string {
  return absPath.slice(gitDir.length).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Object DB, reflog, index and locks: high-churn or huge, never branch-relevant. */
function isNoise(absPath: string, gitDir: string): boolean {
  const rel = relInGitDir(absPath, gitDir);
  if (rel === '') return false; // the gitDir root itself
  if (rel.endsWith('.lock')) return true;
  if (rel === 'index' || rel === 'FETCH_HEAD' || rel === 'COMMIT_EDITMSG' || rel === 'ORIG_HEAD') return true;
  const top = rel.split('/')[0];
  // `fsmonitor--daemon/` holds git's builtin filesystem-monitor IPC socket +
  // cookie files, which it rewrites constantly — prune so we never open handles on it.
  return (
    top === 'objects' || top === 'logs' || top === 'lfs' || top === 'hooks' ||
    top === 'info' || top === 'modules' || top === 'worktrees' || top === 'fsmonitor--daemon'
  );
}

/** Map a changed git-dir entry to the kind of git event it represents. */
function classify(absPath: string, gitDir: string): GitMetaChange | null {
  const rel = relInGitDir(absPath, gitDir);
  if (rel === 'HEAD') return 'head';
  if (rel === 'packed-refs' || rel.startsWith('refs/')) return 'ref';
  if (
    rel === 'MERGE_HEAD' || rel === 'CHERRY_PICK_HEAD' || rel === 'REVERT_HEAD' || rel === 'REBASE_HEAD' ||
    rel.startsWith('rebase-merge/') || rel.startsWith('rebase-apply/') || rel.startsWith('sequencer/')
  ) {
    return 'sequencer';
  }
  return null;
}

/** The deepest watched gitdir that contains `p` (a submodule gitdir lives under
 *  the main one, so longest-match wins). Separator-agnostic. Exported for tests. */
export function ownerGitDir(gitDirs: string[], p: string): string | null {
  let best: string | null = null;
  for (const gd of gitDirs) if (isUnderOrEq(gd, p) && (!best || gd.length > best.length)) best = gd;
  return best;
}

/** The chokidar `ignored` decision across the watched gitdirs: prune a path iff
 *  it's noise within its OWNING gitdir (so each repo's object DB is pruned while
 *  its HEAD/refs are watched). Exported so the cross-platform separator contract
 *  is unit-tested (chokidar v4 feeds forward-slash paths; gitdirs are native). */
export function isWatchIgnored(gitDirs: string[], p: string): boolean {
  const gd = ownerGitDir(gitDirs, p);
  return gd ? isNoise(p, gd) : false;
}

const DEBOUNCE_MS = 250;

interface Subscription {
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}

export class GitMetaWatcher {
  private watchers = new Map<number, Subscription>();

  /** Arm the watcher for one project. No-op when the project isn't a git repo.
   *  Watches the main gitdir PLUS each initialized submodule's gitdir, so a
   *  branch switch / commit inside a submodule still fires (and bumps the UI's
   *  git revision → editor change markers re-fetch their submodule baseline). */
  startWatching(projectId: number, rootPath: string, events: GitMetaWatcherEvents): void {
    if (this.watchers.has(projectId)) return;
    const subscription: Subscription = {};
    this.watchers.set(projectId, subscription);
    const active = () => this.watchers.get(projectId) === subscription;
    void this.arm(rootPath, events, subscription, active).finally(() => {
      if (active() && !subscription.watcher) this.watchers.delete(projectId);
    }).catch(error => {
      if (active()) void this.stopWatching(projectId);
      console.warn('[git-meta] Could not watch repository metadata:', error);
    });
  }

  private async arm(rootPath: string, events: GitMetaWatcherEvents, subscription: Subscription, active: () => boolean): Promise<void> {
    const context = await resolveGitContext(rootPath);
    if (!context || !active()) return;
    const { repoRoot, gitDir: mainGitDir } = context;
    const [common, initialHead] = await Promise.all([resolveCommonGitDir(mainGitDir), readHead(mainGitDir)]);
    if (!active()) return;
    const gitDirs = [...new Set(common ? [mainGitDir, common] : [mainGitDir])];
    let lastHead = initialHead;
    let publishing = Promise.resolve();
    const pending = new Set<GitMetaChange>();
    const watcher = watch(gitDirs, {
      persistent: true,
      ignoreInitial: true,
      ignored: (p: string) => isWatchIgnored(gitDirs, p),
      // HEAD/refs are written via write-then-rename; a short settle avoids
      // reading a half-written file before we re-read it ourselves.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const onEvent = (filePath: string) => {
      if (!active()) return;
      const gd = ownerGitDir(gitDirs, filePath);
      if (!gd) return;
      const kind = classify(filePath, gd);
      if (!kind) return;
      if (gd === common && gd !== mainGitDir && kind !== 'ref') return;
      pending.add(kind);
      clearTimeout(subscription.timer);
      // Coalesce: a checkout touches HEAD (+ refs) in a burst — fire once.
      subscription.timer = setTimeout(() => {
        const changed = [...pending];
        pending.clear();
        publishing = publishing.then(async () => {
          if (!active()) return;
          const head = await readHead(mainGitDir);
          if (!active()) return;
          if (head.branch !== null || head.detached) lastHead = head;
          await events.onChange({ ...lastHead, changed });
        }).catch(error => console.warn('[git-meta] Could not publish a metadata change:', error));
      }, DEBOUNCE_MS);
    };

    watcher.on('add', onEvent);
    watcher.on('change', onEvent);
    watcher.on('unlink', onEvent);
    subscription.watcher = watcher;
    const add = (dirs: string[]) => {
      if (!active()) return;
      const additions = [...new Set(dirs)].filter(dir => !gitDirs.includes(dir));
      if (!additions.length) return;
      gitDirs.push(...additions);
      watcher.add(additions);
    };
    // The selected checkout is already watched while slow sibling directories
    // are inspected. A retired subscription cannot attach handles to its successor.
    await Promise.all([
      resolveSubmoduleGitDirs(repoRoot, active).then(add),
      resolveNestedGitDirs(rootPath, active).then(add),
    ]);
  }

  async stopWatching(projectId: number): Promise<void> {
    const subscription = this.watchers.get(projectId);
    this.watchers.delete(projectId);
    clearTimeout(subscription?.timer);
    await subscription?.watcher?.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.watchers.keys()).map((id) => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  /** Current branch snapshot (changed:[]) — used to seed a new subscriber so it
   *  can tell a real switch from its first frame. Null when not a git repo. */
  async readCurrent(rootPath: string): Promise<GitMetaEvent | null> {
    const context = await resolveGitContext(rootPath);
    if (!context) return null;
    const { branch, detached } = await readHead(context.gitDir);
    return { branch, detached, changed: [] };
  }
}
