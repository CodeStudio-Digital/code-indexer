/**
 * Handlers for the `files` namespace. Wraps the existing DB lookups
 * (apps/http-api/server/routes/files.ts) and adds three new operations
 * the IDE workspace needs:
 *
 *   - `read`  — raw file contents (Monaco opens a file)
 *   - `write` — persist edits (Ctrl+S)
 *   - `tree`  — recursive directory listing for the FileTreeRail
 *
 * Read/write are scoped to the project's `root_path` with strict path
 * traversal protection. The DB-backed `list` is still the right call
 * for "indexed files" queries; `tree` walks the filesystem live.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ApiError, type FilesApi, type FileTreeNode } from '@mcp/api-bus';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import { detectDockerfile } from '@mcp/services/sandbox/dockerfile-detector.js';
import {
  clearProjectIgnoreRulesCache,
  directoryIgnoreRules,
  getProjectDiscoveryCacheVersion,
  isProjectDiscoveryMarker,
  getProjectIgnoreRulesAsync,
  shouldIgnoreProjectPath,
} from '@mcp/shared/utils/project-ignore.js';
import { mapLimit } from '@mcp/shared/utils/map-limit.js';
import { readProjectDirectory } from '@mcp/shared/utils/project-directory-reads.js';
import type { HandlerDeps } from '../types.js';
import { createDirCache } from './dir-cache.js';
import { cancelArchive, runArchiveJob, runArchiveJobToEnd } from './archive-runner.js';
import { captureLocalHistory } from './local-history.js';
import { createHistoryHandlers } from './history-handlers.js';

// Baseline + Java/.NET/Unity project profiles live in project-ignore.ts.

/**
 * Cap on concurrent `fs.stat` calls while listing a directory. libuv's default
 * threadpool is 4; going much wider just queues, and queuing thousands blocks
 * every other async fs operation in the process behind them.
 */
const STAT_CONCURRENCY = 32;

/**
 * Resolve a project-relative path to an absolute one, refusing any
 * resolved path that escapes the project's `root_path`. Returns the
 * absolute path. Throws ApiError(403) on traversal attempts.
 */
export function resolveSafe(rootPath: string, rel: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const candidate = path.resolve(normalizedRoot, rel);
  // path.relative returns '..' if the candidate escapes root.
  const inside = path.relative(normalizedRoot, candidate);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new ApiError('path_escape', 403, 'path escapes project root');
  }
  return candidate;
}

export function createFilesHandlers(deps: HandlerDeps): FilesApi {
  const { db } = deps;
  // Cache TTL-curto do fast path de `tree` (W2/P3). Flag MCP_TREE_DIR_CACHE=0 = rollback.
  const dirCache = createDirCache();
  const cacheEnabled = (): boolean => process.env.MCP_TREE_DIR_CACHE !== '0';

  function requireProject(projectId: number) {
    const project = db.getProjectCatalogEntry(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project;
  }

  // ─── archive/extract helpers ────────────────────────────────────────
  // Path resolution and index bookkeeping stay on the main thread; only the
  // blocking compression crosses into the worker. `resolveSafe` runs HERE, so
  // a traversal attempt is refused before a thread is even spawned (the worker
  // re-validates archive member names independently — see archive-plan.ts).

  function planArchiveJob(projectId: number, paths: string[] | undefined, out: string) {
    const project = requireProject(projectId);
    if (!paths?.length) throw new ApiError('bad_request', 400, 'no paths to archive');
    const roots = paths.map((rel) => resolveSafe(project.root_path, rel));
    return {
      job: { kind: 'archive' as const, roots, out: resolveSafe(project.root_path, out) },
      outRel: out,
    };
  }

  function afterArchive(projectId: number, outRel: string): void {
    // A new file on disk → mark it for (re)indexing, same as `write`.
    deps.projectIndexService.markDirty(projectId, [{ path: outRel.replace(/\\/g, '/'), kind: 'upsert' }]);
    dirCache.invalidate(projectId, outRel);
  }

  function planExtractJob(projectId: number, zipRel: string, dest: string) {
    const project = requireProject(projectId);
    return {
      kind: 'extract' as const,
      zip: resolveSafe(project.root_path, zipRel),
      dest: resolveSafe(project.root_path, dest),
    };
  }

  function afterExtract(projectId: number, dest: string): void {
    const project = requireProject(projectId);
    deps.projectIndexService.publishFsEvents(projectId, [{ path: dest.replace(/\\/g, '/'), kind: 'upsert', isDir: true }]);
    clearProjectIgnoreRulesCache(project.root_path);
    dirCache.invalidate(projectId, dest);
  }

  return {
    ...createHistoryHandlers(deps),

    async searchPaths({ projectId, query, limit, fuzzy }) {
      requireProject(projectId);
      if (typeof query !== 'string') throw new ApiError('bad_request', 400, 'query must be a string');
      return db.searchFilePaths(projectId, query, limit, fuzzy);
    },
    async searchPathsPage({ projectId, query, limit, fuzzy }, ctx) {
      requireProject(projectId);
      ctx.signal?.throwIfAborted();
      if (typeof query !== 'string') throw new ApiError('bad_request', 400, 'query must be a string');
      const take = Math.max(1, Math.min(300, Math.floor(limit ?? 50) || 50));
      const items = db.searchFilePaths(projectId, query, take, fuzzy);
      const raw = db.projectScopedDb(projectId);
      const overBudget = raw.prepare('SELECT 1 FROM files WHERE project_id=? LIMIT 1 OFFSET 5000').get(projectId) !== undefined;
      const partial = overBudget || items.length >= take;
      return { items, completeness: partial ? 'partial' : 'complete', source: 'structural_index',
        revision: db.getStructuralRevision(projectId), candidateLimit: 5000,
        ...(partial ? { reason: 'candidate_or_result_budget' as const } : {}) };
    },
    async list({ projectId }) {
      return db.listFiles(projectId);
    },

    async manifest({ projectId }) {
      const project = requireProject(projectId);
      return {
        manifest: detectManifest(project.root_path),
        dockerfile: detectDockerfile(project.root_path),
      };
    },

    async get({ projectId, path: filePath }) {
      const file = db.getFile(projectId, filePath);
      if (!file) throw new ApiError('not_found', 404, 'file not found');
      const symbols = db.getSymbolsByFile(projectId, filePath);
      const dependencies = db.getDependencies(file.id, projectId);
      const dependents = db.getDependents(projectId, file.id);
      return { ...file, symbols, dependencies, dependents };
    },

    async read({ projectId, path: rel, ifModifiedSince }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      try {
        // Stat first: the SWR caller (tab activation, fs-event echo) skips
        // the payload entirely when mtime matches what it already has.
        const stat = await fs.stat(abs);
        const lastModified = stat.mtime.toISOString();
        if (ifModifiedSince && ifModifiedSince === lastModified) {
          return { notModified: true as const, last_modified: lastModified };
        }
        const content = await fs.readFile(abs, 'utf8');
        return { content, encoding: 'utf8' as const, last_modified: lastModified };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ApiError('not_found', 404, 'file not found on disk');
        }
        throw err;
      }
    },

    async write({ projectId, path: rel, content, encoding }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      // Local History: snapshot da PRÉ-imagem ANTES de sobrescrever (a leitura
      // precisa preceder o write, senão os bytes antigos já se foram). Fail-open
      // por dentro — jamais rejeita o save.
      await captureLocalHistory(deps, projectId, rel, { kind: 'save', readFrom: abs });
      // Ensure parent dir exists — saving a new file under a fresh folder
      // (common when scaffolding) shouldn't require a separate mkdir call.
      const createdDirectory = await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      const stat = await fs.stat(abs);
      // Fast-path: symbols/FTS fresh in ~ms instead of waiting for the
      // chokidar debounce (the watcher event later short-circuits on hash).
      deps.projectIndexService.markDirty(projectId, [{ path: rel.replace(/\\/g, '/'), kind: 'upsert' }]);
      if (createdDirectory || isProjectDiscoveryMarker(abs)) clearProjectIgnoreRulesCache(project.root_path);
      dirCache.invalidate(projectId, rel); // próximo tree do parent reflete o arquivo novo
      return { ok: true as const, last_modified: stat.mtime.toISOString() };
    },

    async delete({ projectId, path: rel, recursive }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      // Refuse to delete the project root or a path that resolves to it.
      if (abs === path.resolve(project.root_path)) {
        throw new ApiError('refuse_root_delete', 400, 'refusing to delete project root');
      }
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) {
          await fs.rm(abs, { recursive: recursive ?? false, force: false });
          // Children removals arrive via the watcher (per-file unlink events).
        } else {
          // Local History: snapshot ANTES do unlink → deleção recuperável.
          await captureLocalHistory(deps, projectId, rel, { kind: 'pre-delete', readFrom: abs });
          await fs.unlink(abs);
          deps.projectIndexService.markDirty(projectId, [{ path: rel.replace(/\\/g, '/'), kind: 'delete' }]);
        }
        if (stat.isDirectory() || isProjectDiscoveryMarker(abs)) clearProjectIgnoreRulesCache(project.root_path);
        dirCache.invalidate(projectId, rel);
        return { ok: true as const };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new ApiError('not_found', 404, 'file not found');
        if (code === 'ENOTEMPTY') {
          throw new ApiError('dir_not_empty', 409, 'directory is not empty (pass recursive: true)');
        }
        throw err;
      }
    },

    async rename({ projectId, from, to }) {
      const project = requireProject(projectId);
      const absFrom = resolveSafe(project.root_path, from);
      const absTo = resolveSafe(project.root_path, to);
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      try {
        await fs.rename(absFrom, absTo);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ApiError('not_found', 404, 'source path not found');
        }
        throw err;
      }
      let lastModified: string | null = null;
      let isFile = false;
      try {
        const stat = await fs.stat(absTo);
        isFile = stat.isFile();
        lastModified = stat.mtime.toISOString();
      } catch {
        /* renamed away (directory): mtime not meaningful */
      }
      if (isFile) {
        // Directory renames fan out via the watcher; the single-file case
        // gets the instant delete+create the index models a rename as.
        deps.projectIndexService.markDirty(projectId, [
          { path: from.replace(/\\/g, '/'), kind: 'delete' },
          { path: to.replace(/\\/g, '/'), kind: 'upsert' },
        ]);
      }
      if (!isFile || isProjectDiscoveryMarker(absFrom) || isProjectDiscoveryMarker(absTo)) clearProjectIgnoreRulesCache(project.root_path);
      dirCache.invalidate(projectId, from);
      dirCache.invalidate(projectId, to);
      return { ok: true as const, last_modified: lastModified };
    },

    async mkdir({ projectId, path: rel }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      await fs.mkdir(abs, { recursive: true });
      // Watcher would surface this after the debounce; publish directly so
      // the tree shows the new folder instantly.
      deps.projectIndexService.publishFsEvents(projectId, [
        { path: rel.replace(/\\/g, '/'), kind: 'upsert', isDir: true },
      ]);
      clearProjectIgnoreRulesCache(project.root_path);
      dirCache.invalidate(projectId, rel);
      return { ok: true as const };
    },

    // ─── archive / extract ──────────────────────────────────────────
    //
    // Both run in a short-lived worker thread. adm-zip is fully synchronous
    // (readFileSync per member, deflateRawSync over the whole archive, sync
    // write), so doing this inline froze every window, all IPC and every PTY
    // stream for the duration. See archive-runner.ts / archive-worker.ts.
    //
    // The `*Stream` variants below are what the UI uses; these two drain the
    // same job so non-UI callers keep a plain promise.

    async archive({ projectId, paths, out }) {
      const { job, outRel } = planArchiveJob(projectId, paths, out);
      await runArchiveJobToEnd(`archive:${projectId}:${outRel}`, job);
      afterArchive(projectId, outRel);
      return { ok: true as const, path: outRel };
    },

    async *archiveStream({ projectId, paths, out, archiveId }) {
      const { job, outRel } = planArchiveJob(projectId, paths, out);
      yield* runArchiveJob(archiveId ?? `archive:${projectId}:${outRel}`, job);
      afterArchive(projectId, outRel);
    },

    async extract({ projectId, zip: zipRel, dest }) {
      const job = planExtractJob(projectId, zipRel, dest);
      const res = await runArchiveJobToEnd(`extract:${projectId}:${dest}`, job);
      afterExtract(projectId, dest);
      return { ok: true as const, files: res.files, bytes: res.bytes };
    },

    async *extractStream({ projectId, zip: zipRel, dest, archiveId }) {
      const job = planExtractJob(projectId, zipRel, dest);
      yield* runArchiveJob(archiveId ?? `extract:${projectId}:${dest}`, job);
      afterExtract(projectId, dest);
    },

    async archiveCancel({ archiveId }) {
      return { ok: true as const, cancelled: cancelArchive(archiveId) };
    },

    async tree({ projectId, maxDepth = 6, root = '.', withStats }, ctx) {
      const project = requireProject(projectId);
      const startAbs = resolveSafe(project.root_path, root);
      const startRel = root === '.' ? '' : root;

      // Fast path — the lazy explorer (maxDepth 1) is the hot caller. ONE
      // readdir; entry types come from the Dirents (the old walk re-statted
      // every child: a 300-entry folder cost 300 stats + a readdir PEEK per
      // subdirectory, seconds on Windows+Defender). Chevrons are drawn
      // optimistically for dirs (IntelliJ/VS Code do the same — an empty
      // dir just expands to nothing).
      if (maxDepth <= 1) {
        const signal = ctx?.signal;
        signal?.throwIfAborted();
        const version = getProjectDiscoveryCacheVersion(project.root_path);
        const variant = withStats ? 'stats' : 'plain';
        if (cacheEnabled()) {
          const cached = dirCache.get(projectId, startRel, variant);
          if (cached) return cached;
        }
        const entries = await readProjectDirectory(project.root_path, startAbs, version, true).catch(() => []);
        signal?.throwIfAborted();
        const projectIgnore = await directoryIgnoreRules(project.root_path, startAbs, entries);
        signal?.throwIfAborted();
        const children: FileTreeNode[] = [];
        const needsStat: FileTreeNode[] = [];
        for (const [index, e] of entries.entries()) {
          if (index > 0 && index % 512 === 0) {
            await new Promise<void>(done => setImmediate(done));
            signal?.throwIfAborted();
          }
          const relPath = path.posix.join(startRel, e.name);
          if (shouldIgnoreProjectPath(projectIgnore, relPath, e.isDirectory())) continue;
          const child: FileTreeNode = e.isDirectory()
            ? { name: e.name, path: relPath, type: 'dir', hasChildren: true }
            : { name: e.name, path: relPath, type: 'file' };
          children.push(child);
          if (withStats || e.isSymbolicLink()) needsStat.push(child);
        }
        await mapLimit(needsStat, STAT_CONCURRENCY, async child => {
          signal?.throwIfAborted();
          const st = await fs.stat(path.join(startAbs, child.name)).catch(() => null);
          if (!st) return;
          if (st.isDirectory()) {
            child.type = 'dir';
            child.hasChildren = true;
          }
          child.size = st.size;
          child.mtime = st.mtimeMs;
          child.mode = st.mode;
        });
        signal?.throwIfAborted();
        children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const node: FileTreeNode = {
          name: path.basename(startAbs) || project.name,
          path: startRel,
          type: 'dir',
          children,
        };
        // Cached per VARIANT, so a zero-stat FileTreeRail node can never be
        // served to the SFTP pane (which would render its columns blank) and
        // the pane's repeated navigations stop re-statting the whole directory.
        if (cacheEnabled() && version === getProjectDiscoveryCacheVersion(project.root_path)) {
          dirCache.set(projectId, startRel, node, variant);
        }
        return node;
      }

      const projectIgnore = await getProjectIgnoreRulesAsync(project.root_path);
      async function walk(absPath: string, relPath: string, depth: number): Promise<FileTreeNode> {
        const name = path.basename(absPath) || project.name;
        const stat = await fs.stat(absPath).catch(() => null);
        if (!stat) {
          return { name, path: relPath, type: 'file' };
        }
        // The walker already stats every node; when withStats is set, attach
        // size/mtime/mode so deep walks honor the contract too.
        const stats = withStats ? { size: stat.size, mtime: stat.mtimeMs, mode: stat.mode } : {};
        if (!stat.isDirectory()) {
          return { name, path: relPath, type: 'file', ...stats };
        }
        if (depth >= maxDepth) {
          // Peek so the lazy tree knows whether to draw an expand chevron.
          const peek = await fs.readdir(absPath, { withFileTypes: true }).catch(() => []);
          const hasChildren = peek.some((e) =>
            !shouldIgnoreProjectPath(projectIgnore, path.posix.join(relPath, e.name), e.isDirectory()),
          );
          return { name, path: relPath, type: 'dir', hasChildren, ...stats };
        }
        const entries = await fs.readdir(absPath, { withFileTypes: true }).catch(() => []);
        // Stable, case-insensitive ordering: dirs first, then files alphabetically.
        const filtered = entries.filter((e) =>
          !shouldIgnoreProjectPath(projectIgnore, path.posix.join(relPath, e.name), e.isDirectory()),
        );
        filtered.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const children = await Promise.all(
          filtered.map((e) =>
            walk(path.join(absPath, e.name), path.posix.join(relPath, e.name), depth + 1),
          ),
        );
        return { name, path: relPath, type: 'dir', children, ...stats };
      }

      // The root node carries '.' as its relative path so descendants
      // are reachable via plain posix joins (consistent across OSes).
      return walk(startAbs, startRel, 0);
    },

    async symbol({ id, projectId }) {
      // Surrogate id is unique only within a project DB post-split; `projectId`
      // routes the lookup there (central fallback = pre-split behavior).
      const sym = db.getSymbolById(id, projectId);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return sym;
    },

    async symbolMembers({ id, projectId }) {
      const sym = db.getSymbolById(id, projectId);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return db.getClassMembers(sym.name, sym.project_id);
    },
  };
}
