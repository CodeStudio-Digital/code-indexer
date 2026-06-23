import { watch, type FSWatcher } from 'chokidar';
import { relative } from 'node:path';

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

/**
 * Build the chokidar `ignored` predicate for one watched root. A dir name is
 * matched only when it appears BELOW the root — scoped via `path.relative` so a
 * project living under e.g. `C:\temp\app` is not wholesale ignored because of a
 * `temp` / `bin` / `build` ancestor segment (the old globs shared this latent
 * prefix bug). Hand-rolled segment scan over the relative path (no split/regex
 * alloc) since chokidar calls this for every entry during the walk; handles
 * both win32 `\` and posix `/`.
 */
export function makeIgnored(rootPath: string): (p: string) => boolean {
  return (p: string): boolean => {
    const rel = relative(rootPath, p);
    if (!rel || rel.startsWith('..')) return false; // the root itself / outside it
    let start = 0;
    for (let i = 0; i <= rel.length; i++) {
      const c = i === rel.length ? 47 : rel.charCodeAt(i);
      if (c === 47 || c === 92 /* / or \ */) {
        if (i > start && IGNORED_DIRS.has(rel.slice(start, i))) return true;
        start = i + 1;
      }
    }
    return false;
  };
}

export class FileWatcherService {
  private watchers = new Map<number, FSWatcher>();
  private pendingChanges = new Map<number, Map<string, { kind: WatcherFileEvent['kind']; isDir: boolean }>>();
  private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  startWatching(projectId: number, options: WatcherOptions, events: WatcherEvents): void {
    if (this.watchers.has(projectId)) return;

    // `isIgnoredPath` is a FUNCTION (not a glob) so chokidar prunes heavy dirs
    // (node_modules, .git, target, vendor, …) during its walk instead of
    // descending + filtering events — the latter opened ~145 k native watchers.
    // Any caller-supplied `ignorePatterns` (globs) are appended (chokidar v3
    // anymatch accepts the mixed array). The indexer's private working dir
    // (`.mcp-indexer`, with its trash bin + `.tmp` scratch) is in IGNORED_DIRS.
    const ignored = [makeIgnored(options.rootPath), ...(options.ignorePatterns ?? [])];

    const watcher = watch(options.rootPath, {
      persistent: true,
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.pendingChanges.set(projectId, new Map());

    const handleChange = (kind: WatcherFileEvent['kind'], isDir = false) => (filePath: string) => {
      const pending = this.pendingChanges.get(projectId)!;
      // Key carries the dir flag so a file and a dir at the same path (rare
      // rename races) don't clobber each other's semantics.
      pending.set(filePath, { kind, isDir }); // unlink after change collapses to delete

      // Reset debounce timer
      const existingTimer = this.debounceTimers.get(projectId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(async () => {
        const batch = Array.from(pending, ([path, v]) => ({ path, kind: v.kind, isDir: v.isDir }));
        pending.clear();
        if (batch.length > 0) {
          await events.onFileChanged(batch);
        }
      }, options.debounce);

      this.debounceTimers.set(projectId, timer);
    };

    watcher.on('add', handleChange('upsert'));
    watcher.on('change', handleChange('upsert'));
    watcher.on('unlink', handleChange('delete'));
    watcher.on('addDir', handleChange('upsert', true));
    watcher.on('unlinkDir', handleChange('delete', true));

    this.watchers.set(projectId, watcher);
  }

  async stopWatching(projectId: number): Promise<void> {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectId);
    }

    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }

    this.pendingChanges.delete(projectId);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map(id => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  listWatching(): number[] {
    return Array.from(this.watchers.keys());
  }
}
