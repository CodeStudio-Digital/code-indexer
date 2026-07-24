import { watch, type FSWatcher } from 'chokidar';
import { basename, join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';
import ignore from 'ignore';
import { normalizeIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import {
  getProjectIgnoreRules,
  getProjectIgnoreRulesAsync,
  invalidateProjectDiscoveryCache,
  shouldIgnoreProjectPath,
  type ProjectIgnoreRules,
} from '@mcp/shared/utils/project-ignore.js';
import { invalidateAngularWorkspaceForPath } from '../lsp/angular-workspace-index.js';

export interface WatcherFileEvent {
  /** Absolute path as emitted by chokidar (backslashes on win32 — callers normalize). */
  path: string;
  /** add/change/addDir → upsert; unlink/unlinkDir → delete. Latest event per path wins. */
  kind: 'upsert' | 'delete';
  /** Directory event (addDir/unlinkDir) — consumed by the UI fs-events stream, not the indexer. */
  isDir?: boolean;
}

export interface WatcherEvents {
  onFileChanged(events: WatcherFileEvent[]): void | Promise<void>;
}

export interface WatcherOptions {
  rootPath: string;
  debounce: number;
  ignorePatterns?: string[];
  /**
   * Skip live watching when the watchable tree exceeds this many entries (see
   * {@link countWatchedEntries}). 0/undefined disables the guard.
   */
  maxWatchedFiles?: number;
}

/**
 * Directory names that hold dependencies / build output / tool caches across
 * ecosystems. We must NOT recursively watch these: a single monorepo
 * `node_modules` is hundreds of thousands of nested dirs, and chokidar opens
 * one native `fs.watch` handle PER directory — that bloated the main-process
 * heap to ~1.85 GB with ~145 k `FSEventWrap` handles and thrashed GC (the
 * project-open freeze on large repos).
 *
 * Matched as a path SEGMENT via {@link isIgnoredPath} — NOT as a glob. The old
 * `'**​/node_modules/**'` glob only filtered *events*; the glob does not match
 * the `node_modules` directory itself, so chokidar still descended into it and
 * opened the watchers. A function that matches the directory makes chokidar
 * PRUNE the subtree during its initial walk (no descent, no handles).
 *
 * Deliberately NOT here (these are commonly SOURCE roots, especially in
 * monorepos): `packages`, `apps`, `src`, `lib`, `app`, `source`, `public`,
 * `assets`, `static`, `scripts`, `tools`, `config`, `test(s)`, `spec`, `docs`,
 * `examples`, `env`. The authoritative full index has its own scanner ignore
 * (`buildScannerIgnore`), so pruning the *watcher* never affects index
 * correctness — at most a watched dir under one of these names misses a live
 * incremental update until the next full scan.
 */
const IGNORED_DIRS = new Set<string>([
  // ── VCS ───────────────────────────────────────────────────────────────
  '.git', '.hg', '.svn', '.bzr', '_darcs', 'CVS',
  // ── JS / TS: dependencies ─────────────────────────────────────────────
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnp', '.pnpm-store', '.npm', '.changeset',
  // ── JS / TS: build output + framework caches ──────────────────────────
  'dist', 'build', 'out', 'output', '.output', '.nitro',
  '.next', '.nuxt', '.angular', '.svelte-kit', '.astro', '.solid', '.remix',
  '.docusaurus', '.vitepress', '.vuepress', '.contentlayer', '.tanstack',
  '.cache', '.parcel-cache', '.rpt2_cache', '.rollup.cache', '.fusebox',
  '.turbo', '.vercel', '.netlify', '.serverless', '.webpack', '.umi', '.dumi',
  'storybook-static', '.storybook-out', '.expo', '.expo-shared', '.metro-health-check',
  // ── Test / coverage ───────────────────────────────────────────────────
  'coverage', '.nyc_output', 'htmlcov', 'TestResults', 'test-results',
  'playwright-report', 'blob-report', '.playwright',
  // ── Python ────────────────────────────────────────────────────────────
  '__pycache__', '.venv', 'venv', '.virtualenv', 'virtualenv', '__pypackages__',
  '.mypy_cache', '.ruff_cache', '.pytest_cache', '.pytype', '.pyre',
  '.tox', '.nox', '.eggs', '.ipynb_checkpoints', '.hypothesis', 'site-packages',
  '.pdm-build', '.pixi', '.conda', 'cython_debug',
  // ── PHP ───────────────────────────────────────────────────────────────
  'vendor', '.phpunit.cache', 'bootstrap/cache',
  // ── Java / Kotlin / JVM (Maven, Gradle, Eclipse, Android) ─────────────
  'target', '.gradle', '.settings', '.metadata', '.recommenders', '.cxx', 'captures',
  // ── C# / .NET ─────────────────────────────────────────────────────────
  'bin', 'obj', '.vs', '.nuget',
  // ── C / C++ / CMake ───────────────────────────────────────────────────
  'CMakeFiles', 'cmake-build-debug', 'cmake-build-release', '.deps', '.libs',
  // ── Elixir / Erlang ───────────────────────────────────────────────────
  '_build', 'deps', '.elixir_ls', '.fetch',
  // ── Dart / Flutter ────────────────────────────────────────────────────
  '.dart_tool', '.pub-cache', '.flutter-plugins',
  // ── Swift / iOS / macOS ───────────────────────────────────────────────
  'Pods', 'DerivedData', '.build', 'Carthage', '.swiftpm',
  // ── Haskell ───────────────────────────────────────────────────────────
  '.stack-work', 'dist-newstyle',
  // ── Ruby ──────────────────────────────────────────────────────────────
  '.bundle', '_yardoc', '.yardoc',
  // ── Infra as code ─────────────────────────────────────────────────────
  '.terraform', '.terragrunt-cache', '.pulumi', 'cdk.out',
  // ── IDE / editor (heavy / regenerated) ────────────────────────────────
  '.idea', '.history', '.fleet', '.metals', '.bloop', '.ammonite', '.vscode-test',
  // ── Misc caches / temp ────────────────────────────────────────────────
  '.sass-cache', 'tmp', 'temp', '.tmp', '.temp',
  // ── This app's own working dir ────────────────────────────────────────
  '.mcp-indexer',
]);

const PROJECT_DISCOVERY_MARKERS = new Set([
  'composer.json',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gradlew', 'mvnw', '.classpath',
  'global.json', 'directory.build.props', 'directory.build.targets',
  'directory.packages.props', 'nuget.config', 'projectversion.txt',
]);

const WATCHER_FLUSH_RETRY_MS = 250;

function isProjectDiscoveryMarker(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  return PROJECT_DISCOVERY_MARKERS.has(name)
    || ['.csproj', '.fsproj', '.vbproj', '.sln', '.slnx'].some((suffix) => name.endsWith(suffix));
}

/**
 * Build the chokidar `ignored` predicate for one watched root. A dir name is
 * matched only when it appears BELOW the root — scoped via `path.relative` so a
 * project living under e.g. `C:\temp\app` is not wholesale ignored because of a
 * `temp` / `bin` / `build` ancestor segment (the old globs shared this latent
 * prefix bug). Hand-rolled segment scan over the relative path (no split/regex
 * alloc) since chokidar calls this for every entry during the walk; handles
 * both win32 `\` and posix `/`.
 */
export function makeIgnored(
  rootPath: string,
  extraPatterns: string[] = [],
  preparedProjectIgnore?: ProjectIgnoreRules,
): (p: string) => boolean {
  const extra = normalizeIndexIgnorePatterns(extraPatterns);
  const ig = extra.length > 0 ? ignore().add(extra) : null;
  const projectIgnore = preparedProjectIgnore ?? getProjectIgnoreRules(rootPath);
  return (p: string): boolean => {
    const rel = relative(rootPath, p).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return false; // the root itself / outside it
    if (shouldIgnoreProjectPath(projectIgnore, rel)) return true;
    if (ig?.ignores(rel) || ig?.ignores(`${rel}/`)) return true;
    let start = 0;
    for (let i = 0; i <= rel.length; i++) {
      const c = i === rel.length ? 47 : rel.charCodeAt(i);
      if (c === 47 /* / */) {
        if (i > start && IGNORED_DIRS.has(rel.slice(start, i))) return true;
        start = i + 1;
      }
    }
    return false;
  };
}

/**
 * Bounded count of the entries chokidar would watch under `rootPath`, honoring
 * `isIgnored` so pruned subtrees (node_modules, Unity's Library, …) never
 * descend. Every file inside a watched directory is counted because chokidar
 * re-enumerates the whole directory on each change within it — that enumeration,
 * not just the emitted event, is the cost the budget guards against. Returns as
 * soon as the count passes `cap`, so an oversized tree costs ~`cap` stats rather
 * than a full walk. Uses async fs so the main thread stays free during the probe.
 */
export async function countWatchedEntries(
  rootPath: string,
  isIgnored: (absPath: string) => boolean,
  cap: number,
): Promise<number> {
  let count = 0;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (perms/race) — skip, don't abort the probe
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnored(child)) continue; // pruned: no handle, no descent
        if (++count > cap) return count;
        stack.push(child);
      } else if (++count > cap) {
        return count;
      }
    }
  }
  return count;
}

export class FileWatcherService {
  private watchers = new Map<number, FSWatcher>();
  private ready = new Map<number, Promise<void>>();
  private resolveReady = new Map<number, () => void>();
  private events = new Map<number, WatcherEvents>();
  private pendingChanges = new Map<number, Map<string, { kind: WatcherFileEvent['kind']; isDir: boolean }>>();
  private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Projects whose budget probe is in flight, keyed to a per-attempt token so a
   * probe that a stop/restart superseded (e.g. an ignore-pattern change) bails
   * instead of arming with stale rules. Membership counts as "watching" so the
   * caller doesn't re-arm.
   */
  private arming = new Map<number, object>();
  /** Projects skipped because their tree exceeded the budget — no chokidar handle exists. */
  private skipped = new Set<number>();
  /** Projects under bulk-op suppression (branch switch) — see {@link suspend}. */
  private suspendedProjects = new Set<number>();

  private scheduleFlush(projectId: number, delayMs: number): void {
    const existing = this.debounceTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(projectId);
      this.flushPendingSafely(projectId);
    }, delayMs);
    this.debounceTimers.set(projectId, timer);
  }

  private flushPendingSafely(projectId: number): void {
    void this.flushPending(projectId).catch((error) => {
      console.warn(
        `[watcher] flush failed for project ${projectId}; retrying buffered events:`,
        error instanceof Error ? error.message : String(error),
      );
      if (!this.suspendedProjects.has(projectId)
        && (this.pendingChanges.get(projectId)?.size ?? 0) > 0) {
        this.scheduleFlush(projectId, WATCHER_FLUSH_RETRY_MS);
      }
    });
  }

  startWatching(projectId: number, options: WatcherOptions, events: WatcherEvents): void {
    if (this.isWatching(projectId)) return;

    // `ready` means chokidar completed its initial walk. Structural indexing
    // waits for this edge so edits made during the full scan are observed and
    // drained before the baseline is published as ready. Created synchronously
    // so `waitUntilReady` observes it even while the async budget probe runs; an
    // early error / skip resolves it so lifecycle callers never wait forever —
    // the structural reconciliation is the authoritative fallback either way.
    this.ready.set(projectId, new Promise<void>((resolve) => {
      this.resolveReady.set(projectId, resolve);
    }));
    const settleReady = () => {
      this.resolveReady.get(projectId)?.();
      this.resolveReady.delete(projectId);
    };

    // Scope discovery used to synchronously recurse here before chokidar even
    // armed. Prepare the predicate asynchronously and mark the project arming
    // immediately so concurrent lifecycle calls cannot start a duplicate.
    const token = {};
    this.arming.set(projectId, token);
    void getProjectIgnoreRulesAsync(options.rootPath).then((projectIgnore) => {
      if (this.arming.get(projectId) !== token) return;
      // `ignored` is a FUNCTION (not a glob) so chokidar prunes heavy dirs
      // (node_modules, .git, target, vendor, …) during its walk.
      const ignored = makeIgnored(options.rootPath, options.ignorePatterns ?? [], projectIgnore);
      const maxFiles = options.maxWatchedFiles ?? 0;
      if (maxFiles <= 0) {
        this.arming.delete(projectId);
        this.armFileWatcher(projectId, options, ignored, events, settleReady);
        return;
      }
      // Probe the tree size off the main thread before arming. A project bigger
      // than the budget (e.g. a Unity project whose `Assets/` holds tens of
      // thousands of imported asset files the user never edits) would make
      // chokidar open a handle per subdir and re-read whole directories on every
      // editor/tool touch — a sustained CPU drain. Skip live watching for it;
      // git-meta events + the structural reconcile keep it fresh.
      void countWatchedEntries(options.rootPath, ignored, maxFiles)
        .then((count) => {
          // Superseded by a stop/restart — the newer attempt (or stopWatching)
          // owns the ready promise, so bail without arming or settling.
          if (this.arming.get(projectId) !== token) return;
          this.arming.delete(projectId);
          if (count > maxFiles) {
            this.skipped.add(projectId);
            console.warn(
              `[watcher] project ${projectId} exceeds the ${maxFiles}-entry watch budget ` +
              `(${options.rootPath}); skipping live file-watching — git-meta events + ` +
              `structural reconcile remain authoritative for freshness.`,
            );
            settleReady();
            return;
          }
          this.armFileWatcher(projectId, options, ignored, events, settleReady);
        })
        .catch(() => {
          if (this.arming.get(projectId) !== token) return;
          this.arming.delete(projectId);
          settleReady();
        });
    }).catch(() => {
      if (this.arming.get(projectId) !== token) return;
      this.arming.delete(projectId);
      settleReady();
    });
  }

  /** Create the chokidar watcher for a project that passed the budget probe. */
  private armFileWatcher(
    projectId: number,
    options: WatcherOptions,
    ignored: (p: string) => boolean,
    events: WatcherEvents,
    settleReady: () => void,
  ): void {
    const watcher = watch(options.rootPath, {
      persistent: true,
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    watcher.once('ready', settleReady);
    watcher.on('error', settleReady);

    this.pendingChanges.set(projectId, new Map());
    this.events.set(projectId, events);

    const handleChange = (kind: WatcherFileEvent['kind'], isDir = false) => (filePath: string) => {
      if (!isDir) invalidateAngularWorkspaceForPath(options.rootPath, filePath);
      if (isDir || isProjectDiscoveryMarker(filePath)) {
        invalidateProjectDiscoveryCache(options.rootPath);
      }
      this.noteChange(projectId, filePath, kind, isDir, options.debounce);
    };

    watcher.on('add', handleChange('upsert'));
    watcher.on('change', handleChange('upsert'));
    watcher.on('unlink', handleChange('delete'));
    watcher.on('addDir', handleChange('upsert', true));
    watcher.on('unlinkDir', handleChange('delete', true));

    this.watchers.set(projectId, watcher);
  }

  /**
   * Buffer one chokidar event and (unless suspended) re-arm the debounce
   * flush. Extracted from the chokidar closure so the suppression/buffering
   * semantics are unit-testable without arming a real watcher.
   */
  private noteChange(
    projectId: number,
    filePath: string,
    kind: WatcherFileEvent['kind'],
    isDir: boolean,
    debounceMs: number,
  ): void {
    const pending = this.pendingChanges.get(projectId);
    if (!pending) return; // stopped mid-event
    // Key carries the dir flag so a file and a dir at the same path (rare
    // rename races) don't clobber each other's semantics.
    pending.set(filePath, { kind, isDir }); // unlink after change collapses to delete

    // Bulk-op suppression: keep coalescing into the buffer (latest-per-path)
    // but never arm the debounce flush — the reconcile's scan-barrier
    // flushPending (or resume) delivers whatever accumulated.
    if (this.suspendedProjects.has(projectId)) return;

    // Reset debounce timer
    this.scheduleFlush(projectId, debounceMs);
  }

  /** Resolves after chokidar's initial walk for the project's current handle. */
  waitUntilReady(projectId: number): Promise<void> {
    return this.ready.get(projectId) ?? Promise.resolve();
  }

  /**
   * Bulk-op suppression (mirrors IntelliJ's BatchFileChangeListener): a branch
   * switch touches thousands of working-tree files whose per-file drain is
   * fully superseded by the stat-first reconcile the switch triggers. Discard
   * the already-buffered burst and stop arming the debounce flush; events that
   * arrive while suspended still coalesce into the buffer so the reconcile's
   * scan-barrier `flushPending` observes mid-scan edits. Idempotent.
   */
  suspend(projectId: number): void {
    this.suspendedProjects.add(projectId);
    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }
    this.pendingChanges.get(projectId)?.clear();
  }

  /** End bulk-op suppression; deliver anything buffered while suspended. */
  resume(projectId: number): void {
    if (!this.suspendedProjects.delete(projectId)) return;
    if ((this.pendingChanges.get(projectId)?.size ?? 0) > 0) this.flushPendingSafely(projectId);
  }

  /** Deliver the current debounce buffer immediately (used at scan barriers). */
  async flushPending(projectId: number): Promise<void> {
    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }
    const pending = this.pendingChanges.get(projectId);
    const sink = this.events.get(projectId);
    if (!pending || !sink || pending.size === 0) return;
    const batch = Array.from(pending, ([path, v]) => ({ path, kind: v.kind, isDir: v.isDir }));
    pending.clear();
    try {
      await sink.onFileChanged(batch);
    } catch (error) {
      // Preserve any newer same-path event that arrived while the sink was in
      // flight; otherwise restore the failed event so a timer/resume retry can
      // deliver it. Clearing before invoking the sink keeps new events separate
      // and makes this merge deterministic.
      const current = this.pendingChanges.get(projectId);
      if (current) {
        for (const event of batch) {
          if (!current.has(event.path)) {
            current.set(event.path, { kind: event.kind, isDir: !!event.isDir });
          }
        }
      }
      throw error;
    }
  }

  async stopWatching(projectId: number): Promise<void> {
    // Cancel an in-flight budget probe (its `.then` bails when arming is gone)
    // and clear a prior skip so a later arm re-probes (the tree may have shrunk).
    this.arming.delete(projectId);
    this.skipped.delete(projectId);
    this.suspendedProjects.delete(projectId);

    const watcher = this.watchers.get(projectId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectId);
    }

    this.resolveReady.get(projectId)?.();
    this.resolveReady.delete(projectId);
    this.ready.delete(projectId);

    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }

    this.pendingChanges.delete(projectId);
    this.events.delete(projectId);
  }

  async stopAll(): Promise<void> {
    const ids = new Set([
      ...this.watchers.keys(), ...this.arming.keys(), ...this.skipped, ...this.suspendedProjects,
    ]);
    await Promise.all(Array.from(ids, (id) => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    // `arming`/`skipped` count as "watching" so the lifecycle doesn't re-arm a
    // project whose probe is still running or that was intentionally skipped.
    return this.watchers.has(projectId) || this.arming.has(projectId) || this.skipped.has(projectId);
  }

  /** Live watching skipped by the budget guard — the open-files fallback poll's hook. */
  isSkipped(projectId: number): boolean {
    return this.skipped.has(projectId);
  }

  listWatching(): number[] {
    return Array.from(this.watchers.keys());
  }
}
