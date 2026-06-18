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
import { TREE_BLOCK } from '@mcp/shared/utils/fs-ignore.js';
import type { HandlerDeps } from '../types.js';
import { createDirCache } from './dir-cache.js';
import { captureLocalHistory } from './local-history.js';
import { createHistoryHandlers } from './history-handlers.js';

// Blocklist de diretórios do `tree` — fonte única em @mcp/shared/utils/fs-ignore.

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
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project;
  }

  return {
    ...createHistoryHandlers(deps),

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
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      const stat = await fs.stat(abs);
      // Fast-path: symbols/FTS fresh in ~ms instead of waiting for the
      // chokidar debounce (the watcher event later short-circuits on hash).
      deps.projectIndexService.markDirty(projectId, [{ path: rel.replace(/\\/g, '/'), kind: 'upsert' }]);
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
      dirCache.invalidate(projectId, rel);
      return { ok: true as const };
    },

    async tree({ projectId, maxDepth = 6, root = '.' }) {
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
        if (cacheEnabled()) {
          const cached = dirCache.get(projectId, startRel);
          if (cached) return cached;
        }
        const entries = await fs.readdir(startAbs, { withFileTypes: true }).catch(() => []);
        const filtered = entries.filter((e) => !TREE_BLOCK.has(e.name));
        const children = await Promise.all(filtered.map(async (e): Promise<FileTreeNode> => {
          const relPath = path.posix.join(startRel, e.name);
          // Symlinked dirs (pnpm links) report as symlink, not directory —
          // they're the only case worth a stat (rare outside node_modules).
          let isDir = e.isDirectory();
          if (!isDir && e.isSymbolicLink()) {
            const st = await fs.stat(path.join(startAbs, e.name)).catch(() => null);
            isDir = st?.isDirectory() ?? false;
          }
          return isDir
            ? { name: e.name, path: relPath, type: 'dir', hasChildren: true }
            : { name: e.name, path: relPath, type: 'file' };
        }));
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
        if (cacheEnabled()) dirCache.set(projectId, startRel, node);
        return node;
      }

      async function walk(absPath: string, relPath: string, depth: number): Promise<FileTreeNode> {
        const name = path.basename(absPath) || project.name;
        const stat = await fs.stat(absPath).catch(() => null);
        if (!stat) {
          return { name, path: relPath, type: 'file' };
        }
        if (!stat.isDirectory()) {
          return { name, path: relPath, type: 'file' };
        }
        if (depth >= maxDepth) {
          // Peek so the lazy tree knows whether to draw an expand chevron.
          const peek = await fs.readdir(absPath, { withFileTypes: true }).catch(() => []);
          const hasChildren = peek.some((e) => !TREE_BLOCK.has(e.name));
          return { name, path: relPath, type: 'dir', hasChildren };
        }
        const entries = await fs.readdir(absPath, { withFileTypes: true }).catch(() => []);
        // Stable, case-insensitive ordering: dirs first, then files alphabetically.
        const filtered = entries.filter((e) => !TREE_BLOCK.has(e.name));
        filtered.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const children = await Promise.all(
          filtered.map((e) =>
            walk(path.join(absPath, e.name), path.posix.join(relPath, e.name), depth + 1),
          ),
        );
        return { name, path: relPath, type: 'dir', children };
      }

      // The root node carries '.' as its relative path so descendants
      // are reachable via plain posix joins (consistent across OSes).
      return walk(startAbs, startRel, 0);
    },

    async symbol({ id }) {
      const sym = db.getSymbolById(id);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return sym;
    },

    async symbolMembers({ id }) {
      const sym = db.getSymbolById(id);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return db.getClassMembers(sym.name, sym.project_id);
    },

    async listConcepts({ projectId }) {
      return db.listConcepts(projectId);
    },

    async conceptFiles({ projectId, concept }) {
      return db.getFilesByConcept(projectId, concept);
    },
  };
}
